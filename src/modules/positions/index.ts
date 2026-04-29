/**
 * Virtual (paper-trading) position tracker.
 *
 * Flow:
 *   scan writes brain md with a "💰 开单建议" section
 *   → parseSetups() extracts direction/SL/T1/T2/leverage per candidate
 *   → openPositionsFromScan() uses the ticker's live `last` (not the LLM's
 *     suggested entry range) as entry_price, inserts a row in positions
 *   → every 5min, checkOpenPositions() pulls prices for all open positions
 *     and closes any that crossed SL or T1 (T1-full-exit policy per user spec)
 *   → Telegram notification only at open + terminal close (per user spec)
 */
import { v4 as uuidv4 } from "uuid";
import cron from "node-cron";
import { db } from "../../db/client.js";
import { sendTelegram, escapeHtml } from "../../lib/telegram.js";
import { config } from "../../config.js";

// ─── Types ───────────────────────────────────────────────────────────

interface Candidate {
  symbol: string;
  direction: "LONG" | "SHORT";
  setup?: string;
  leverage: number;
  sl: number;
  t1: number;
  t2: number;
  rationale?: string;
}

type Trigger = "sl_hit" | "t1_hit";

// ─── Parser: pull candidates from a scan markdown ────────────────────

export function parseSetups(md: string): Candidate[] {
  const sectionMatch = md.match(
    /##\s*💰\s*开单建议[\s\S]*?(?=\n##\s|$)/
  );
  if (!sectionMatch) return [];
  const body = sectionMatch[0];

  // Each ### heading starts a candidate. Split on "\n### ".
  const blocks = body.split(/\n###\s+/).slice(1);
  const out: Candidate[] = [];

  for (const b of blocks) {
    // Symbol — must look like *USDT
    const symMatch = b.match(/\b([A-Z][A-Z0-9_]{2,19}USDT)\b/);
    const symbol = symMatch?.[1];
    if (!symbol) continue;

    // Direction
    const direction: "LONG" | "SHORT" | null =
      /\bLONG\b|做多|看多/i.test(b)
        ? "LONG"
        : /\bSHORT\b|做空|看空/i.test(b)
          ? "SHORT"
          : null;
    if (!direction) continue;

    // Numeric extractors — tolerate $ prefix, Chinese colon, bold markers
    const num = (rx: RegExp): number | null => {
      const m = b.match(rx);
      if (!m) return null;
      const n = parseFloat(m[1].replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    };

    const leverage = num(/leverage\s*[：:]?\s*\*{0,2}(\d+(?:\.\d+)?)\s*x/i);
    const sl = num(/SL\s*[：:]\s*\*{0,2}\$?(\d+(?:\.\d+)?)/i);
    const t1 = num(/T1\s*[：:]\s*\*{0,2}\$?(\d+(?:\.\d+)?)/i);
    const t2 = num(/T2\s*[：:]\s*\*{0,2}\$?(\d+(?:\.\d+)?)/i);
    if (leverage === null || sl === null || t1 === null || t2 === null) continue;

    const setupMatch = b.match(/Setup\s+\d+[^\n·]{0,40}/i);
    const setup = setupMatch?.[0]?.trim();

    // Rationale: first bullet line (first "- " in block)
    const firstBullet = b.match(/\n-\s+(.+?)(?=\n|$)/);
    const rationale = firstBullet?.[1]?.slice(0, 300);

    out.push({ symbol, direction, setup, leverage, sl, t1, t2, rationale });
  }

  return out;
}

// ─── Binance price fetch (lightweight, proxied) ──────────────────────

async function fapi<T>(path: string): Promise<T> {
  const base = "https://fapi.binance.com";
  const res = await fetch(base + path, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`fapi ${path} HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function getLastPrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  // /fapi/v1/ticker/price returns all; filter. Array form of param is picky, so
  // just fetch the whole list once — it's small (~500 rows, ~20KB).
  try {
    const all = (await fapi<Array<{ symbol: string; price: string }>>(
      "/fapi/v1/ticker/price"
    )) as any[];
    const want = new Set(symbols);
    const out: Record<string, number> = {};
    for (const r of all) {
      if (want.has(r.symbol)) {
        const p = parseFloat(r.price);
        if (Number.isFinite(p)) out[r.symbol] = p;
      }
    }
    return out;
  } catch (e) {
    console.error("[position] ticker/price fetch failed:", e);
    return {};
  }
}

// ─── Position lifecycle ─────────────────────────────────────────────

export async function openPositionsFromScan(
  scanId: string,
  scanMarkdown: string
): Promise<number> {
  const candidates = parseSetups(scanMarkdown);
  if (candidates.length === 0) return 0;

  const prices = await getLastPrices(candidates.map((c) => c.symbol));
  let opened = 0;

  for (const c of candidates) {
    const last = prices[c.symbol];
    if (last === undefined) {
      console.warn(`[position] skip ${c.symbol} — no live price`);
      continue;
    }

    const id = uuidv4();
    try {
      await db.query(
        `INSERT INTO positions
          (id, scan_id, symbol, direction, setup, entry_price,
           sl_price, t1_price, t2_price, leverage, stake_usd, rationale)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          scanId,
          c.symbol,
          c.direction,
          c.setup ?? null,
          last,
          c.sl,
          c.t1,
          c.t2,
          c.leverage,
          100,
          c.rationale ?? null,
        ]
      );
      opened++;
      await notifyOpen({
        id,
        symbol: c.symbol,
        direction: c.direction,
        setup: c.setup,
        entryPrice: last,
        slPrice: c.sl,
        t1Price: c.t1,
        t2Price: c.t2,
        leverage: c.leverage,
        rationale: c.rationale,
      });
    } catch (e) {
      console.error(`[position] insert failed for ${c.symbol}:`, e);
    }
  }

  return opened;
}

function classifyTrigger(
  direction: "LONG" | "SHORT",
  entry: number,
  sl: number,
  t1: number,
  price: number
): Trigger | null {
  if (direction === "LONG") {
    if (price <= sl) return "sl_hit";
    if (price >= t1) return "t1_hit";
  } else {
    if (price >= sl) return "sl_hit";
    if (price <= t1) return "t1_hit";
  }
  void entry;
  return null;
}

export async function checkOpenPositions(): Promise<void> {
  const { rows } = await db.query(`SELECT * FROM positions WHERE status='open'`);
  if (rows.length === 0) return;

  const symbols = Array.from(new Set(rows.map((r: any) => r.symbol as string)));
  const prices = await getLastPrices(symbols);

  for (const pos of rows) {
    const px = prices[pos.symbol];
    if (px === undefined) continue;

    const entry = Number(pos.entry_price);
    const sl = Number(pos.sl_price);
    const t1 = Number(pos.t1_price);
    const lev = Number(pos.leverage);

    const trig = classifyTrigger(pos.direction, entry, sl, t1, px);
    if (!trig) continue;

    const priceMovePct =
      pos.direction === "LONG"
        ? ((px - entry) / entry) * 100
        : ((entry - px) / entry) * 100;
    // PnL in USD on a 100U stake at `lev` leverage. priceMovePct is the raw
    // price move as a percent; leveraged pnl% = priceMovePct × lev.
    const pnlUsd = (priceMovePct / 100) * 100 * lev;

    await db.query(
      `UPDATE positions SET status=$2, close_price=$3, pnl_usd=$4, pnl_pct=$5, closed_at=NOW() WHERE id=$1`,
      [pos.id, trig, px, pnlUsd.toFixed(2), priceMovePct.toFixed(2)]
    );

    await notifyClose({
      id: pos.id,
      symbol: pos.symbol,
      direction: pos.direction,
      setup: pos.setup,
      entryPrice: entry,
      closePrice: px,
      trigger: trig,
      leverage: lev,
      priceMovePct,
      pnlUsd,
      openedAt: new Date(pos.opened_at),
    });
  }
}

// ─── Telegram notifications ─────────────────────────────────────────

function dirEmoji(d: string): string {
  return d === "LONG" ? "🟢" : "🔴";
}

async function notifyOpen(p: {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  setup?: string;
  entryPrice: number;
  slPrice: number;
  t1Price: number;
  t2Price: number;
  leverage: number;
  rationale?: string;
}): Promise<void> {
  const slPct =
    p.direction === "LONG"
      ? ((p.slPrice - p.entryPrice) / p.entryPrice) * 100
      : ((p.entryPrice - p.slPrice) / p.entryPrice) * 100;
  const t1Pct =
    p.direction === "LONG"
      ? ((p.t1Price - p.entryPrice) / p.entryPrice) * 100
      : ((p.entryPrice - p.t1Price) / p.entryPrice) * 100;

  const lines = [
    `📌 <b>登记虚拟持仓</b> · ${dirEmoji(p.direction)} <b>${escapeHtml(p.symbol)}</b>`,
    p.setup ? `<i>${escapeHtml(p.setup)}</i>` : null,
    `进场 <b>$${p.entryPrice.toFixed(p.entryPrice < 1 ? 6 : 4)}</b> · ${p.leverage}x · 100U`,
    `SL $${p.slPrice.toFixed(p.entryPrice < 1 ? 6 : 4)} (${slPct.toFixed(1)}%)` +
      ` · T1 $${p.t1Price.toFixed(p.entryPrice < 1 ? 6 : 4)} (${t1Pct.toFixed(1)}%)`,
    p.rationale ? `💡 ${escapeHtml(p.rationale.slice(0, 200))}` : null,
  ].filter(Boolean);

  await sendTelegram(lines.join("\n"));
}

async function notifyClose(p: {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  setup?: string;
  entryPrice: number;
  closePrice: number;
  trigger: Trigger;
  leverage: number;
  priceMovePct: number;
  pnlUsd: number;
  openedAt: Date;
}): Promise<void> {
  const emoji = p.trigger === "sl_hit" ? "🔻" : "✅";
  const label = p.trigger === "sl_hit" ? "止损触发" : "止盈 T1 触发";
  const heldMs = Date.now() - p.openedAt.getTime();
  const heldMin = Math.round(heldMs / 60_000);
  const heldStr = heldMin < 60 ? `${heldMin}m` : `${Math.floor(heldMin / 60)}h ${heldMin % 60}m`;
  const pnlSign = p.pnlUsd >= 0 ? "+" : "";

  const lines = [
    `${emoji} <b>${label}</b> · ${dirEmoji(p.direction)} <b>${escapeHtml(p.symbol)}</b>`,
    `进场 $${p.entryPrice.toFixed(p.entryPrice < 1 ? 6 : 4)} → 平仓 <b>$${p.closePrice.toFixed(p.closePrice < 1 ? 6 : 4)}</b>`,
    `持仓 ${heldStr} · 价格变动 ${pnlSign}${p.priceMovePct.toFixed(2)}% · 实盈亏 <b>${pnlSign}${p.pnlUsd.toFixed(1)}U</b>（100U × ${p.leverage}x）`,
  ];

  await sendTelegram(lines.join("\n"));
}

// ─── Scheduler ──────────────────────────────────────────────────────

let monitorStarted = false;

export function startPositionMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;
  if (!config.telegram.enabled) {
    console.log("[position monitor] telegram disabled — will still track but skip notifications");
  }
  cron.schedule("*/5 * * * *", () => {
    checkOpenPositions().catch((e) => console.error("[position monitor]", e));
  });
  console.log("[position monitor] enabled, cron=*/5 * * * *");
}
