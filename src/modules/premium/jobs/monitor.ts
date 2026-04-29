/**
 * Premium 5-min monitor — sends reply-style updates threaded under the
 * original premium card.
 *
 * Trigger conditions (any one fires an update):
 *   1. mcap moved ≥ +30% from last update (or entry if never updated).
 *      Caps at one update per 30% step so we don't spam at flat 30%.
 *   2. New high-influence tweet appeared since last update (xapi
 *      enrichment delta — KOL ≥10K-followers OR 3+ new recent tweets).
 *   3. New key-entity reference (Musk/Trump/AI/USGov…) NOT present at
 *      previous push.
 *
 * Update body is intentionally short — the original card carries the
 * full context, the update is just "what changed". Telegram threads
 * them via reply_to_message_id.
 */
import cron from "node-cron";
import { db } from "../../../db/client.js";
import { sendPremiumUpdate } from "../telegram.js";
import { enrichCandidate, type EnrichmentResult } from "../enrichment.js";
import type { PremiumCandidate } from "../filter.js";

interface PendingSignal {
  id: string;
  chain: string;
  address: string;
  symbol: string | null;
  pushed_at: Date;
  entry_mcap: number;
  telegram_message_id: number | null;
  last_update_at: Date | null;
  update_count: number;
  enrichment: EnrichmentResult | null;
  narrative_snapshot: { what_is?: string | null; direction?: string | null; recent_reason?: string | null };
  last_market_cap: number;
  last_recent_reason: string | null;
}

const MCAP_STEP = 0.30;            // ≥+30% triggers an update
const MAX_UPDATES_PER_SIGNAL = 8;  // protect against runaway noise
const ACTIVE_WINDOW_HOURS = 24;

async function loadPendingSignals(): Promise<PendingSignal[]> {
  const { rows } = await db.query(
    `SELECT s.id, s.chain, s.address, s.symbol, s.pushed_at, s.entry_mcap,
            s.telegram_message_id, s.last_update_at, s.update_count, s.enrichment,
            s.narrative_snapshot,
            t.last_market_cap, t.recent_reason
       FROM premium_signals s
       LEFT JOIN token_analyses t ON t.chain = s.chain AND t.address = s.address
      WHERE s.outcome_status = 'pending'
        AND s.telegram_message_id IS NOT NULL
        AND s.update_count < $1
        AND s.pushed_at > NOW() - ($2 || ' hours')::INTERVAL`,
    [MAX_UPDATES_PER_SIGNAL, String(ACTIVE_WINDOW_HOURS)],
  );
  return rows.map((r: any) => ({
    id: r.id,
    chain: r.chain,
    address: r.address,
    symbol: r.symbol,
    pushed_at: new Date(r.pushed_at),
    entry_mcap: Number(r.entry_mcap ?? 0),
    telegram_message_id: r.telegram_message_id,
    last_update_at: r.last_update_at ? new Date(r.last_update_at) : null,
    update_count: Number(r.update_count ?? 0),
    enrichment: r.enrichment as EnrichmentResult | null,
    narrative_snapshot: r.narrative_snapshot ?? {},
    last_market_cap: Number(r.last_market_cap ?? 0),
    last_recent_reason: r.recent_reason ?? null,
  }));
}

/**
 * Fetch live mcap+price from DexScreener. Called at monitor time so
 * the reply update reflects RIGHT NOW, not the stale last_market_cap
 * from the last 15-min meme scan. Returns null on any failure — the
 * monitor falls back to the cached value.
 */
async function fetchLiveQuote(chain: string, address: string): Promise<{ mcap: number; price: number } | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const pairs: any[] = data?.pairs ?? [];
    if (pairs.length === 0) return null;
    // Match the chain to avoid grabbing a wrapped-version on another network.
    const wantedChain = chain.toLowerCase() === "eth" ? "ethereum"
                       : chain.toLowerCase() === "sol" ? "solana"
                       : chain.toLowerCase();
    const matching = pairs.filter((p) => (p.chainId ?? "").toLowerCase() === wantedChain);
    const list = matching.length > 0 ? matching : pairs;
    list.sort((a, b) => (Number(b?.liquidity?.usd ?? 0)) - (Number(a?.liquidity?.usd ?? 0)));
    const top = list[0];
    const mcap = Number(top?.marketCap ?? top?.fdv ?? 0);
    const price = Number(top?.priceUsd ?? 0);
    if (!isFinite(mcap) || mcap === 0) return null;
    return { mcap, price };
  } catch (e) {
    console.warn(`[premium monitor] live quote failed for ${chain}/${address}:`, e);
    return null;
  }
}

function fmtUsd(n: number): string {
  if (!isFinite(n) || n === 0) return "?";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

interface UpdateDecision {
  shouldUpdate: boolean;
  body: string;
  newEnrichment: EnrichmentResult | null;
}

async function evaluateUpdate(s: PendingSignal): Promise<UpdateDecision> {
  const reasons: string[] = [];

  // 1. mcap step — query DexScreener for the up-to-the-minute mcap
  // rather than relying on token_analyses.last_market_cap (which only
  // refreshes every 15 min when the token is re-analyzed). Fall back
  // to cached value on fetch failure so we still send updates when
  // dexscreener hiccups.
  const baseMcap = s.entry_mcap > 0 ? s.entry_mcap : 1;
  const live = await fetchLiveQuote(s.chain, s.address);
  const liveMcap = live?.mcap ?? s.last_market_cap;
  const moveX = liveMcap / baseMcap;
  // Trigger only when crossing a NEW step we haven't reported.
  // update_count of N corresponds to having reported up through (1+MCAP_STEP)^N.
  const stepsCrossed = moveX > 1 ? Math.floor(Math.log(moveX) / Math.log(1 + MCAP_STEP)) : 0;
  const hitMcapStep = stepsCrossed > s.update_count && liveMcap >= baseMcap * (1 + MCAP_STEP);
  if (hitMcapStep) reasons.push(`mcap_step:${stepsCrossed}x`);

  // 2 + 3. xapi enrichment delta
  let newEnrichment: EnrichmentResult | null = null;
  try {
    const fakePremium: PremiumCandidate = {
      chain: s.chain,
      address: s.address,
      symbol: s.symbol,
      narrative_what_is: s.narrative_snapshot.what_is ?? null,
      narrative_direction: s.narrative_snapshot.direction ?? null,
      recent_reason: s.last_recent_reason ?? s.narrative_snapshot.recent_reason ?? null,
      last_price: 0,
      last_market_cap: liveMcap,
      last_liquidity: 0,
      latest_anomaly_score: 0,
      last_safety: {},
      last_analyzed_at: new Date(),
    };
    newEnrichment = await enrichCandidate(fakePremium);
  } catch (e) {
    console.warn(`[premium monitor] enrichment failed for ${s.symbol}:`, e);
  }

  if (newEnrichment) {
    const oldEntities = new Set((s.enrichment?.key_entities ?? []));
    const newEntities = newEnrichment.key_entities.filter((e) => !oldEntities.has(e));
    if (newEntities.length > 0) reasons.push(`new_entities:${newEntities.join(",")}`);

    const oldFollowers = s.enrichment?.evidence?.high_follower_tweet?.followers ?? 0;
    const newFollowers = newEnrichment.evidence.high_follower_tweet?.followers ?? 0;
    if (newFollowers > oldFollowers && newFollowers >= 50_000) {
      reasons.push(`new_kol:${newEnrichment.evidence.high_follower_tweet?.screen_name}=${Math.round(newFollowers / 1000)}k`);
    }
    const oldTweetCount = s.enrichment?.evidence?.recent_tweet_count ?? 0;
    if (newEnrichment.evidence.recent_tweet_count >= oldTweetCount + 10
        && newEnrichment.evidence.recent_tweet_count >= 15) {
      reasons.push(`tweet_volume:+${newEnrichment.evidence.recent_tweet_count - oldTweetCount}`);
    }
  }

  if (reasons.length === 0) {
    return { shouldUpdate: false, body: "", newEnrichment };
  }

  // Live mcap line ALWAYS appears, regardless of trigger type. User
  // wants every reply update to lead with the current price/mcap so
  // they don't have to scroll back up to the original card to gauge
  // whether the new info matters.
  const lines: string[] = [];
  lines.push(`🔔 <b>${escapeHtml(s.symbol ?? "?")}</b> 更新`);

  const livePct = baseMcap > 0 ? ((liveMcap / baseMcap) - 1) * 100 : 0;
  const moveEmoji = livePct >= 100 ? "🚀" : livePct >= 30 ? "📈" : livePct <= -30 ? "📉" : "→";
  lines.push(`💰 市值 <b>${fmtUsd(liveMcap)}</b> · ${moveEmoji} 较推送 <b>${livePct >= 0 ? "+" : ""}${livePct.toFixed(0)}%</b> (入场 ${fmtUsd(s.entry_mcap)})`);

  if (newEnrichment) {
    if (newEnrichment.evidence.high_follower_tweet) {
      const t = newEnrichment.evidence.high_follower_tweet;
      lines.push(`🐦 @${escapeHtml(t.screen_name)} (${Math.round(t.followers / 1000)}k 粉)：${escapeHtml(t.text.slice(0, 160))}`);
    }
    // Render entities with their LLM-judged evidence quote so the user
    // can verify the connection rather than trust a bare label. (Past
    // bug: GOBLIN got tagged "musk" with no evidence shown — turned
    // out to be perfume musk in someone's bio.)
    for (const k of newEnrichment.key_entities) {
      const ev = newEnrichment.entity_evidence?.[k];
      if (ev?.text) {
        lines.push(`🏷 <b>${escapeHtml(k)}</b>：${escapeHtml(ev.text.slice(0, 200))}`);
      } else {
        lines.push(`🏷 <b>${escapeHtml(k)}</b>`);
      }
    }
  }
  lines.push(`<i>触发：${escapeHtml(reasons.join(" · "))}</i>`);

  return { shouldUpdate: true, body: lines.join("\n"), newEnrichment };
}

async function runMonitorTick(): Promise<void> {
  const pending = await loadPendingSignals();
  if (pending.length === 0) return;
  console.log(`[premium monitor] checking ${pending.length} pending signals`);

  for (const s of pending) {
    if (!s.telegram_message_id) continue;
    try {
      const decision = await evaluateUpdate(s);
      if (!decision.shouldUpdate) continue;

      await sendPremiumUpdate(s.telegram_message_id, decision.body);
      await db.query(
        `UPDATE premium_signals
            SET last_update_at = NOW(),
                update_count = update_count + 1,
                enrichment = COALESCE($2, enrichment)
          WHERE id = $1`,
        [s.id, decision.newEnrichment ? JSON.stringify(decision.newEnrichment) : null],
      );
      // Spread sends across the tick to dodge Telegram rate limits.
      await new Promise((r) => setTimeout(r, 400));
    } catch (e) {
      console.error(`[premium monitor] failed for ${s.symbol}@${s.chain}:`, e);
    }
  }
}

let task: cron.ScheduledTask | null = null;

export function startPremiumMonitor(): void {
  if (task) return;
  task = cron.schedule("*/5 * * * *", () => {
    runMonitorTick().catch((e) => console.error("[premium monitor tick]", e));
  });
  console.log("[premium monitor] scheduled */5 min");
}

export function stopPremiumMonitor(): void {
  if (task) { task.stop(); task = null; }
}
