/**
 * Premium scan orchestrator.
 *
 * Subscribes to the meme module's scan_done event. On each tick:
 *   1. Load this scan's candidates from token_analyses (joined with
 *      the freshly-persisted last_safety snapshot).
 *   2. Apply hard gates (mcap window, liq, single-maker, honeypot,
 *      narrative present).
 *   3. Drop tokens we've already pushed (one push per token rule;
 *      monitor handles updates via reply).
 *   4. Run xapi enrichment on the surviving + the "weak narrative"
 *      tokens — promote any whose external search hits all three
 *      signals (recent + influential + key-entity).
 *   5. Pick best-of-breed across same-symbol clusters; one leader per
 *      cluster.
 *   6. Push to premium bot, persist premium_signals with the returned
 *      Telegram message_id so the monitor can reply later.
 */
import { subscribeScans } from "../../meme/jobs/scan.js";
import { db } from "../../../db/client.js";
import {
  applyHardGates,
  loadAlreadyPushedKeys,
  loadLatestScanCandidates,
  type PremiumCandidate,
  type FilterRejection,
} from "../filter.js";
import { pickBestPerCluster, type ClusterPick, scoreCandidate } from "../chain-picker.js";
import { enrichCandidate, type EnrichmentResult } from "../enrichment.js";
import { pushPremiumPicks } from "../telegram.js";

interface PreparedSignal {
  pick: ClusterPick;
  enrichment: EnrichmentResult | null;
}

async function runPremiumScan(scanId: string): Promise<void> {
  const t0 = Date.now();
  console.log(`[premium scan ${scanId.slice(0, 8)}] start`);

  // Load + filter
  const all = await loadLatestScanCandidates(5);
  const { passed: hardPassed, rejected } = applyHardGates(all);

  if (rejected.length > 0) {
    console.log(`[premium scan ${scanId.slice(0, 8)}] gates rejected ${rejected.length}/${all.length}; sample:`,
      rejected.slice(0, 5).map((r) => `${r.symbol}@${r.chain}:${r.reasons.join("/")}`).join(" | "));
  }

  // Drop already-pushed
  const pushedKeys = await loadAlreadyPushedKeys();
  const fresh = hardPassed.filter((c) => !pushedKeys.has(`${c.chain}:${c.address}`));
  const dedupedOut = hardPassed.length - fresh.length;
  if (dedupedOut > 0) {
    console.log(`[premium scan ${scanId.slice(0, 8)}] dedupe dropped ${dedupedOut} already-pushed`);
  }

  if (fresh.length === 0) {
    console.log(`[premium scan ${scanId.slice(0, 8)}] no fresh premium candidates; done in ${Date.now() - t0}ms`);
    return;
  }

  // xapi enrichment — runs on the survivors. Cheap heuristic pass, no
  // LLM. We capture results even when 'all_three' is false because
  // they go into premium_signals.enrichment for the reflector.
  const enrichments = new Map<string, EnrichmentResult>();
  await Promise.all(
    fresh.map(async (c) => {
      try {
        const r = await enrichCandidate(c);
        enrichments.set(`${c.chain}:${c.address}`, r);
      } catch (e) {
        console.warn(`[premium enrich] ${c.symbol}:`, e);
      }
    }),
  );

  // Cross-chain best-of-breed
  const { picks } = pickBestPerCluster(fresh);

  // Push + collect message ids
  const messageIds = await pushPremiumPicks(picks);

  // Persist premium_signals
  for (const p of picks) {
    const c = p.leader;
    const key = `${c.chain}:${c.address}`;
    const enrichment = enrichments.get(key) ?? null;
    const messageId = messageIds.get(key) ?? null;
    try {
      await db.query(
        `INSERT INTO premium_signals
           (scan_id, chain, address, symbol,
            entry_price, entry_mcap,
            filter_snapshot, narrative_snapshot,
            cluster_key, cluster_chains, cluster_chosen_reason,
            telegram_message_id, enrichment, outcome_status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'pending')`,
        [
          scanId, c.chain, c.address, c.symbol ?? null,
          c.last_price, c.last_market_cap,
          JSON.stringify({
            ...c.last_safety,
            score: scoreCandidate(c),
            anomaly: c.latest_anomaly_score,
            liquidity: c.last_liquidity,
          }),
          JSON.stringify({
            what_is: c.narrative_what_is,
            direction: c.narrative_direction,
            recent_reason: c.recent_reason,
          }),
          p.cluster_key, p.chains_in_cluster, p.chosen_reason,
          messageId,
          enrichment ? JSON.stringify(enrichment) : null,
        ],
      );
    } catch (e) {
      console.error(`[premium scan] persist signal failed for ${c.symbol}@${c.chain}:`, e);
    }
  }

  console.log(`[premium scan ${scanId.slice(0, 8)}] pushed ${picks.length} picks (from ${fresh.length} fresh, ${all.length} raw) in ${Date.now() - t0}ms`);
}

let unsubscribe: (() => void) | null = null;

export function startPremiumScan(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeScans((event) => {
    if (event.type !== "scan_done") return;
    // Defer to next tick so the meme push has gone out first — keeps
    // the two channels visually synced (main bot card → premium card).
    setTimeout(() => {
      runPremiumScan(event.scanId).catch((e) => console.error("[premium scan]", e));
    }, 500);
  });
  console.log("[premium scan] subscribed to meme scan_done events");
}

export function stopPremiumScan(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
