import { v4 as uuidv4 } from "uuid";
import { createScanAgent } from "../agent/agent-factory.js";
import { buildScanPrompt } from "../agent/prompts/scan.js";
import { config } from "../../../config.js";
import { db } from "../../../db/client.js";
import { SCOPE } from "../brain-scope.js";
import { pushScanPageToTelegram } from "../../../lib/telegram.js";

export interface ScanResult {
  scanId: string;
  durationMs: number;
  status: "done" | "failed";
  summary?: string;
  scanPagePath?: string | null;
  error?: string;
}

export type ScanEventListener = (event: {
  type: "scan_start" | "scan_progress" | "scan_done" | "scan_error";
  scanId: string;
  payload?: unknown;
}) => void;

const listeners = new Set<ScanEventListener>();

export function subscribeScans(fn: ScanEventListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(event: Parameters<ScanEventListener>[0]) {
  for (const fn of listeners) fn(event);
}

export async function runScan(opts?: { chains?: string[] }): Promise<ScanResult> {
  const scanId = uuidv4();
  const chains = opts?.chains ?? config.scan.chains;
  const t0 = Date.now();

  // Cross-process inflight guard. scheduler's in-memory `inflight` only
  // protects same-process re-entry; if a manual scan-once.ts process
  // fires while the server is mid-scan, both hit the GLM key in the
  // same second → 429. Check scan_runs for any non-stale running row.
  // 10-minute staleness window covers the worst-case scan duration
  // (we've seen ~200s) without letting crashed rows block forever.
  try {
    const { rows } = await db.query(
      `SELECT id, ts FROM scan_runs
         WHERE scope = $1 AND status = 'running'
           AND ts > NOW() - INTERVAL '10 minutes'
         ORDER BY ts DESC LIMIT 1`,
      [SCOPE]
    );
    if (rows.length > 0) {
      const other = rows[0].id;
      console.log(`[scan:meme] already inflight: ${other} — refusing to start duplicate`);
      return {
        scanId: "",
        durationMs: 0,
        status: "failed",
        error: `another scan (${other}) is already running`,
      };
    }
  } catch (e) {
    console.warn(`[scan:meme] inflight check failed, proceeding:`, e);
  }

  emit({ type: "scan_start", scanId, payload: { chains } });

  await db.query(
    `INSERT INTO scan_runs (id, scope, ts, chains, status) VALUES ($1, $2, NOW(), $3, 'running')`,
    [scanId, SCOPE, chains]
  );

  const agent = createScanAgent();

  // Capture the most recently written scan page path
  let scanPagePath: string | null = null;
  let lastAssistantText = "";
  let turnCount = 0, totalIn = 0, totalOut = 0, totalCost = 0;
  let toolCount = 0;
  const off = agent.subscribe((event) => {
    if (event.type === "tool_execution_end") {
      const e = event as any;
      const toolName: string | undefined = e.toolName;
      const result = e.result;
      toolCount++;
      console.log(`[scan:meme ${scanId.slice(0,8)}] tool#${toolCount} ${toolName} isError=${e.isError}`);
      if (toolName === "brain_write_scan" && result) {
        try {
          const fromDetails = result?.details?.written;
          const fromContent =
            result?.content?.[0]?.type === "text"
              ? JSON.parse(result.content[0].text)?.written
              : undefined;
          if (fromDetails) scanPagePath = fromDetails;
          else if (fromContent) scanPagePath = fromContent;
          else if (typeof result === "string") {
            scanPagePath = JSON.parse(result)?.written ?? null;
          }
        } catch { /* noop */ }
      }
      emit({ type: "scan_progress", scanId, payload: { tool: toolName, ok: !e.isError } });
    }
    if (event.type === "message_end") {
      const msg = event.message as any;
      if (msg?.role === "assistant") {
        if (Array.isArray(msg.content)) {
          const t = msg.content.find((c: any) => c.type === "text");
          if (t) lastAssistantText = t.text;
        }
        // Per-turn token accounting — so we can see exactly what each LLM
        // round costs and where the bloat is.
        const u = msg.usage ?? {};
        const inTok = u.input ?? u.input_tokens ?? 0;
        const outTok = u.output ?? u.output_tokens ?? 0;
        const cacheRead = u.cacheRead ?? u.cache_read ?? 0;
        const cost = u.cost?.total ?? 0;
        turnCount++;
        totalIn += Number(inTok);
        totalOut += Number(outTok);
        totalCost += Number(cost);
        console.log(
          `[scan:meme ${scanId.slice(0,8)}] turn #${turnCount} in=${inTok} out=${outTok} ` +
          `cacheRead=${cacheRead} cost=¥${Number(cost).toFixed(4)} stopReason=${msg.stopReason}`
        );
        if (msg.stopReason && !["stop","toolUse","end_turn","tool_use"].includes(msg.stopReason)) {
          const err = msg.errorMessage || msg.error || msg.stopError || JSON.stringify(msg).slice(0, 500);
          console.log(`[scan:meme ${scanId.slice(0,8)}] UNUSUAL stopReason=${msg.stopReason} err=${err}`);
        }
      }
    }
  });

  try {
    await agent.prompt(buildScanPrompt(chains));
    const duration = Date.now() - t0;
    // Aggregate cost log at scan end
    console.log(
      `[scan:meme ${scanId.slice(0,8)}] 📊 TOTAL turns=${turnCount} in=${totalIn} out=${totalOut} ` +
      `cost=¥${totalCost.toFixed(4)} duration=${Math.round(duration/1000)}s`
    );
    await db.query(
      `UPDATE scan_runs
          SET duration_ms = $2,
              summary = $3,
              scan_page_path = $4,
              status = 'done'
        WHERE id = $1`,
      [scanId, duration, lastAssistantText.slice(0, 4000), scanPagePath]
    );
    emit({ type: "scan_done", scanId, payload: { durationMs: duration, scanPagePath } });
    if (scanPagePath) {
      pushScanPageToTelegram("meme", scanPagePath, duration).catch((e) =>
        console.error("[telegram meme push]", e)
      );
    }
    return { scanId, durationMs: duration, status: "done", summary: lastAssistantText, scanPagePath };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    await db.query(
      `UPDATE scan_runs SET duration_ms=$2, status='failed', summary=$3 WHERE id=$1`,
      [scanId, Date.now() - t0, err.slice(0, 4000)]
    );
    emit({ type: "scan_error", scanId, payload: { error: err } });
    return { scanId, durationMs: Date.now() - t0, status: "failed", error: err };
  } finally {
    off();
  }
}
