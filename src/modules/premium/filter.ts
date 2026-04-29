/**
 * Premium hard-gate filter.
 *
 * Reads the latest scan's candidates from token_analyses (joined with
 * the freshly persisted last_safety snapshot) and drops anything that
 * doesn't meet the bar:
 *
 *   1. mcap in [MIN_MCAP, MAX_MCAP]                  — no microcap pumps, no megacaps
 *   2. liquidity sanity                              — no rug shells
 *   3. smart_count ≥ 3 OR kol_count ≥ 2              — needs real backers
 *   4. dev_team_hold_rate < 0.25 AND bundler_rate < 0.5 — no single-maker pools
 *   5. is_honeypot=0, rug_ratio < 0.1                — survives basic safety
 *   6. recent_reason is non-empty AND not "未发现新催化"  — needs a story
 *   7. holder_count ≥ MIN_HOLDERS (or null = pass-through, can't tell)
 *
 * Each rejected token is logged with the gate(s) it failed so we can
 * later audit whether thresholds are too tight.
 */
import { db } from "../../db/client.js";

// Filter thresholds. Starting values per user spec; will eventually be
// learned from premium_signals outcomes (see reflector.ts).
export const PREMIUM_GATES = {
  MIN_MCAP: 100_000,            // $100K — user lowered from $500K because some early pumps land here
  MAX_MCAP: 30_000_000,         // $30M  — past this, alpha is gone
  MIN_LIQ: 10_000,              // $10K minimum LP — anything less is exit-liquidity territory
  MIN_SMART: 3,                 // ≥3 smart-money buyers OR
  MIN_KOL: 2,                   //   ≥2 KOL holders (any one of these)
  MAX_DEV_HOLD: 0.25,           // dev/team holds < 25%
  MAX_BUNDLER: 0.5,             // bundler rate < 50% (pump-and-dump signature)
  MAX_RUG_RATIO: 0.1,
  MIN_HOLDERS: 100,             // when holder_count is reported
} as const;

const NO_CATALYST_RX = /近\s*7\s*天.*未发现|未发现新催化|未发现明确催化|未发现.*催化|材料不足/;

export interface PremiumCandidate {
  chain: string;
  address: string;
  symbol: string | null;
  narrative_what_is: string | null;
  narrative_direction: string | null;
  recent_reason: string | null;
  last_price: number;
  last_market_cap: number;
  last_liquidity: number;
  latest_anomaly_score: number;
  last_safety: Record<string, any>;
  last_analyzed_at: Date;
}

export interface FilterRejection {
  chain: string;
  address: string;
  symbol: string | null;
  reasons: string[];
}

export interface FilterResult {
  passed: PremiumCandidate[];
  rejected: FilterRejection[];
}

/**
 * Set of (chain:address) keys we've already pushed and shouldn't push
 * again. Rule: push each token at most ONCE per "active window";
 * subsequent material changes go out as REPLY messages by the monitor.
 *
 * Active window = 7 days from initial push, OR until outcome_status
 * leaves 'pending'. After that the token is eligible to be re-pushed
 * if it trends again.
 */
export async function loadAlreadyPushedKeys(): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const { rows } = await db.query(
      `SELECT chain, address
         FROM premium_signals
        WHERE outcome_status = 'pending'
           OR pushed_at > NOW() - INTERVAL '7 days'`,
    );
    for (const r of rows) out.add(`${r.chain}:${r.address}`);
  } catch (e) {
    console.error("[premium filter] loadAlreadyPushedKeys failed:", e);
  }
  return out;
}

/**
 * Pull every candidate analyzed in the most recent scan window. We use
 * "last_analyzed_at within the past N minutes" as a proxy for "this
 * scan's batch" — simpler than threading scan_id through the pipeline
 * and works fine because scans are 15min apart.
 */
export async function loadLatestScanCandidates(maxAgeMinutes = 5): Promise<PremiumCandidate[]> {
  const { rows } = await db.query(
    `SELECT chain, address, symbol,
            narrative_what_is, narrative_direction, recent_reason,
            last_price, last_market_cap, last_liquidity,
            latest_anomaly_score,
            last_safety,
            last_analyzed_at
       FROM token_analyses
      WHERE last_analyzed_at > NOW() - ($1 || ' minutes')::INTERVAL
        AND passed = false
        AND last_safety IS NOT NULL
      ORDER BY last_analyzed_at DESC`,
    [String(maxAgeMinutes)],
  );
  return rows.map((r: any) => ({
    chain: r.chain,
    address: r.address,
    symbol: r.symbol,
    narrative_what_is: r.narrative_what_is,
    narrative_direction: r.narrative_direction,
    recent_reason: r.recent_reason,
    last_price: Number(r.last_price ?? 0),
    last_market_cap: Number(r.last_market_cap ?? 0),
    last_liquidity: Number(r.last_liquidity ?? 0),
    latest_anomaly_score: Number(r.latest_anomaly_score ?? 0),
    last_safety: r.last_safety || {},
    last_analyzed_at: new Date(r.last_analyzed_at),
  }));
}

export function applyHardGates(candidates: PremiumCandidate[]): FilterResult {
  const passed: PremiumCandidate[] = [];
  const rejected: FilterRejection[] = [];

  for (const c of candidates) {
    const reasons: string[] = [];
    const s = c.last_safety || {};
    const mcap = c.last_market_cap;
    const liq = c.last_liquidity;
    const smart = Number(s.smart_degen_count ?? 0);
    const kol = Number(s.renowned_count ?? 0);
    const devHold = Number(s.dev_team_hold_rate ?? 0);
    const bundler = Number(s.bundler_rate ?? 0);
    const honeypot = Number(s.is_honeypot ?? 0);
    const rug = Number(s.rug_ratio ?? 0);
    const holders = Number(s.holder_count ?? 0);

    // Gate 1: mcap window
    if (mcap < PREMIUM_GATES.MIN_MCAP) reasons.push(`mcap_too_low:$${Math.round(mcap)}`);
    if (mcap > PREMIUM_GATES.MAX_MCAP) reasons.push(`mcap_too_high:$${Math.round(mcap)}`);

    // Gate 2: liquidity sanity
    if (liq < PREMIUM_GATES.MIN_LIQ) reasons.push(`liq_too_thin:$${Math.round(liq)}`);

    // Gate 3: any backer signal
    if (smart < PREMIUM_GATES.MIN_SMART && kol < PREMIUM_GATES.MIN_KOL) {
      reasons.push(`no_backers:smart=${smart},kol=${kol}`);
    }

    // Gate 4: single-maker / bundler signatures
    if (devHold > PREMIUM_GATES.MAX_DEV_HOLD) reasons.push(`dev_hold_high:${(devHold * 100).toFixed(1)}%`);
    if (bundler > PREMIUM_GATES.MAX_BUNDLER) reasons.push(`bundler_high:${(bundler * 100).toFixed(1)}%`);

    // Gate 5: safety
    if (honeypot === 1) reasons.push("honeypot");
    if (rug > PREMIUM_GATES.MAX_RUG_RATIO) reasons.push(`rug_ratio:${(rug * 100).toFixed(1)}%`);

    // Gate 6: narrative present
    const reason = (c.recent_reason || "").trim();
    if (!reason) reasons.push("no_reason");
    else if (NO_CATALYST_RX.test(reason)) reasons.push("no_catalyst");

    // Gate 7: holders (only when reported — many sources don't expose this)
    if (holders > 0 && holders < PREMIUM_GATES.MIN_HOLDERS) {
      reasons.push(`holders_low:${holders}`);
    }

    if (reasons.length === 0) passed.push(c);
    else rejected.push({ chain: c.chain, address: c.address, symbol: c.symbol, reasons });
  }

  return { passed, rejected };
}
