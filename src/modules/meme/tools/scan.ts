/**
 * meme_scan — the one tool the LLM calls.
 *
 * Flow:
 *   1. Fetch per-chain top-10 movers (gmgn sol/base/bsc + ave eth)
 *   2. For each candidate look up token_analyses
 *      A. known & passed = true   → skip
 *      B. known & not passed      → incremental path
 *      C. new                     → full-analysis path
 *   3. Merge + rank by heat_score, return ≤ 15 candidates to the LLM
 *
 * NO agent loop inside. All data fetching, filtering, AI three-question
 * analysis, heat / anomaly math happens inside this one tool. The
 * outer LLM does two things only: call this tool, then call
 * brain_write_scan with the formatted report.
 */
import { Type } from "@sinclair/typebox";
import { defineJsonTool } from "../../../lib/tool-helpers.js";
import { execJson } from "../../../lib/exec.js";
import { db } from "../../../db/client.js";
import {
  xapiTwitterSearch,
  xapiWebSearch,
  type TwitterSearchTweet,
  type WebSearchHit,
} from "../../../lib/xapi.js";
import { slimTrendingItem, hardFilter } from "./gmgn.js";
import { fetchGtPools, gtPoolToSlim } from "../../../lib/geckoterminal.js";
import {
  anomalyScore,
  anomalyDelta,
  discussionCount,
  heatScore,
  decayStoredHeat,
  starRating,
  type HistoryPoint,
  type TweetLike,
} from "../analytics.js";
import {
  analyzeBatch,
  filterUsefulTweets,
  type ThreeAnswers,
  type BatchItem,
  type TweetFilterInput,
} from "../analyzer.js";

// ── Config constants ──────────────────────────────────────────

const TOP_PER_CHAIN = 8;               // 4 chains × 8 = 32 candidates per scan, still under MAX_ANALYZER_BATCH_SIZE=40. Bumped from 5 because real-momentum tokens like ARMA (chg1h=+48%, smart=15) were getting cut at rank ~6-8.
const MIN_AUTHOR_FOLLOWERS = 100;
const STRIKES_TO_PASS = 3;             // "连续 3 次都没讨论则 pass"
const TOP_N_REPORT = 15;               // main LLM consumes ≤ this many
const MAX_ANALYZER_BATCH_SIZE = 40;    // DeepSeek V4 has 1M ctx + 384K out — 40 candidates × ~3K each = 120K, plenty of headroom

// Bot filters — same intent as before, trimmed
const BOT_RE = /🐳.*buy|whale\s*[->→]\s*buy|top\s*call\s*👉|\d+\s*x\s*(?:call|return|gem)|mc\s*:\s*\$?\d+[km]?.{0,40}holder|\$[A-Z0-9]{2,12}.*\$[A-Z0-9]{2,12}.*\$[A-Z0-9]{2,12}/i;

function isBotTweet(t: TwitterSearchTweet): boolean {
  const text = t.text ?? "";
  return BOT_RE.test(text);
}

function tweetTs(t: TwitterSearchTweet): number | null {
  const c = t.created_at;
  if (!c) return null;
  const n = Date.parse(c);
  return Number.isFinite(n) ? n : null;
}

// ── gmgn fetch (cli supports sol/base/bsc/eth as of gmgn-skills v2) ──

async function fetchGmgnChainTop(
  chain: "sol" | "base" | "bsc" | "eth",
  limit: number,
  orderBy: "volume" | "swaps" = "volume",
) {
  const args = [
    "market", "trending",
    "--chain", chain,
    "--interval", "1h",
    "--limit", String(limit),
    "--order-by", orderBy,
    "--raw",
  ];
  if (chain === "sol") {
    args.push("--filter", "renounced", "--filter", "frozen", "--filter", "not_wash_trading");
  } else {
    args.push("--filter", "not_honeypot", "--filter", "verified", "--filter", "renounced");
  }
  try {
    const data = await execJson<{ data: { rank: Record<string, any>[] } }>(
      "gmgn-cli", args, { timeoutMs: 30_000 },
    );
    return (data?.data?.rank ?? []).map(slimTrendingItem);
  } catch (e: any) {
    console.error(`[meme_scan] gmgn ${chain} ${orderBy} failed:`, e?.message ?? e);
    return [];
  }
}

/**
 * Combined ETH fetch: gmgn-cli eth (primary — rich honeypot/rug/holder
 * metadata, same fields as sol/bsc/base) + GeckoTerminal (secondary —
 * catches small-TVL meme rockets that gmgn's trending-by-volume misses,
 * e.g. 0x616af7…Michael which GT flagged at +31541% chg24h but doesn't
 * crack gmgn's top 20 on volume ranking).
 *
 * Dedups by address. gmgn takes precedence because its metadata is
 * richer (same fields as the other chains, so downstream code path is
 * uniform). The old ave path is retired — gmgn-skills added eth support.
 */
/**
 * gmgn + GT combined fetch for a single chain. gmgn gives rich
 * metadata (rug/honeypot/holders), GT gives pump-biased discovery.
 * Both sources' "trending by volume" systematically miss small-TVL
 * day-old memes that pump 5000%+ — GT's composite trending score is
 * the only source that consistently surfaces those.
 */
async function fetchChainTopCombined(chain: "sol" | "eth" | "bsc" | "base", gmgnLimit: number) {
  // Four parallel sources to maximize coverage:
  //   gmgn(volume)  — established/big-volume movers
  //   gmgn(swaps)   — high-tx-count tokens (pump.fun churn often beats
  //                   here even when absolute volume is moderate, e.g.
  //                   LUCA: 12k buys/13k sells in 1h with $1.8M vol)
  //   GT trending   — pump-biased composite
  //   GT new_pools  — freshly-deployed pairs
  const [gmgnByVolume, gmgnBySwaps, gtPools] = await Promise.all([
    fetchGmgnChainTop(chain, gmgnLimit, "volume").catch((e) => { console.error(`[gmgn ${chain} volume]`, e); return []; }),
    fetchGmgnChainTop(chain, gmgnLimit, "swaps").catch((e) => { console.error(`[gmgn ${chain} swaps]`, e); return []; }),
    fetchGtPools(chain, 1).catch((e) => { console.error(`[gt ${chain}]`, e); return []; }),
  ]);
  const norm = (a: string) => chain === "sol" ? a : String(a ?? "").toLowerCase();
  const seen = new Set<string>();
  const merged: any[] = [];
  for (const row of [...gmgnByVolume, ...gmgnBySwaps]) {
    const addr = norm(row.address);
    if (!addr || seen.has(addr)) continue;
    seen.add(addr);
    merged.push(row);
  }
  const gtExtras = gtPools
    .map((p) => gtPoolToSlim(p, chain))
    .filter((t) => t.address && !seen.has(norm(t.address)));
  console.log(
    `[scan:meme] ${chain}: gmgn(vol)=${gmgnByVolume.length} + gmgn(swaps)=${gmgnBySwaps.length} → ` +
    `unique=${merged.length} + gt-extras=${gtExtras.length} = ${merged.length + gtExtras.length}`,
  );
  return [...merged, ...gtExtras];
}

// fetchAveEthTop() removed 2026-04-22 — gmgn-cli added eth support, so
// we route ETH through the same path as sol/bsc/base for uniform
// metadata (rug_ratio / is_honeypot / holder_count / creator / twitter
// from source, no ave nesting quirks). Ave was missing rug/honeypot
// anyway and blue-chip-heavy in its top-100 ranking.

// ── Cross-chain copycat detection ─────────────────────────────
//
// Same meme gets deployed on sol + bsc + eth within days. Some of
// those clones are legit community forks, some are honeypots /
// phishing (e.g. fake PEPE on a new chain that drains LP on first
// sell). We surface groups that:
//   (a) match on normalized name+symbol across ≥ 2 chains
//   (b) have ≥ 1 smart-money or KOL buy signal (gmgn fields)
//   (c) aren't ALL flagged honeypot / high rug_ratio
//
// The caller runs the regular 三问 analysis on individual members;
// the copycat grouping itself is metadata overlay that goes into its
// own Telegram bucket.

/**
 * Collapse a symbol + display name into a match key. Lowercases, strips
 * whitespace / punctuation / emoji / the leading "$" ticker sigil —
 * keeps letters (any script) and digits. So "PEPE", "$PEPE", "Pepe 🐸",
 * "pepe.fun" all collapse to "pepe".
 */
function normalizeTokenKey(symbol: string | undefined, name: string | undefined): string {
  const combined = `${symbol ?? ""}${name ?? ""}`.toLowerCase();
  return combined.replace(/[^\p{L}\p{N}]/gu, "").trim();
}

export interface CopycatMember {
  chain: string;
  address: string;
  symbol: string;
  name?: string | null;
  price: number;
  market_cap: number;
  liquidity: number;
  chg1h: number;
  age_h: number | null;
  smart_degen_count: number;
  renowned_count: number;
  rug_ratio: number;
  is_honeypot: number;
  dev_team_hold_rate: number;
  bundler_rate: number;
  is_suspected_scam: boolean;   // local heuristic flag
}

export interface CopycatGroup {
  key: string;                   // normalized match key
  display_name: string;          // best-representative symbol
  chains: string[];              // unique chains involved
  total_smart_buys: number;      // sum of smart_degen + renowned across members
  members: CopycatMember[];      // sorted by trust-weight desc
  narrative_what_is: string | null;
  narrative_direction: string | null;
  recent_reason: string | null;
}

function detectCrossChainCopycats(sources: any[]): CopycatGroup[] {
  const groups = new Map<string, any[]>();
  for (const s of sources) {
    const key = normalizeTokenKey(s.symbol, s.name);
    // Skip trivially short keys — too prone to false matches ("AI",
    // "M", single-char symbols collide by accident on different chains)
    if (!key || key.length < 3) continue;
    const arr = groups.get(key) ?? [];
    arr.push(s);
    groups.set(key, arr);
  }

  const out: CopycatGroup[] = [];
  for (const [key, raw] of groups) {
    const chainsSet = new Set<string>(raw.map((t) => String(t.chain ?? "")));
    if (chainsSet.size < 2) continue;   // must span ≥ 2 chains

    const members: CopycatMember[] = raw.map((t) => {
      const rug = Number(t.rug_ratio ?? 0);
      const hp = Number(t.is_honeypot ?? 0);
      const dev = Number(t.dev_team_hold_rate ?? 0);
      const bnd = Number(t.bundler_rate ?? 0);
      const isSuspected = hp === 1 || rug > 0.3 || dev > 0.25 || bnd > 0.5;
      return {
        chain: t.chain,
        address: t.address,
        symbol: t.symbol ?? "?",
        name: t.name ?? null,
        price: Number(t.price ?? 0),
        market_cap: Number(t.market_cap ?? 0),
        liquidity: Number(t.liquidity ?? 0),
        chg1h: Number(t.chg1h ?? 0),
        age_h: t.age_h ?? null,
        smart_degen_count: Number(t.smart_degen_count ?? 0),
        renowned_count: Number(t.renowned_count ?? 0),
        rug_ratio: rug,
        is_honeypot: hp,
        dev_team_hold_rate: dev,
        bundler_rate: bnd,
        is_suspected_scam: isSuspected,
      };
    });

    const totalSmart = members.reduce(
      (s, m) => s + m.smart_degen_count + m.renowned_count, 0
    );
    // Gate #1: must have some smart-money signal across the group
    if (totalSmart < 1) continue;

    // Gate #2: if EVERY member is a suspected scam, skip — we only
    // surface groups where at least one chain's version looks clean.
    if (members.every((m) => m.is_suspected_scam)) continue;

    // Sort members by trust-weight: clean + high smart money first
    members.sort((a, b) => {
      if (a.is_suspected_scam !== b.is_suspected_scam) return a.is_suspected_scam ? 1 : -1;
      return (b.smart_degen_count + b.renowned_count) - (a.smart_degen_count + a.renowned_count);
    });

    out.push({
      key,
      display_name: members[0].symbol,
      chains: Array.from(chainsSet),
      total_smart_buys: totalSmart,
      members,
      narrative_what_is: null,
      narrative_direction: null,
      recent_reason: null,
    });
  }
  return out.sort((a, b) => b.total_smart_buys - a.total_smart_buys);
}

// ── Cross-chain copycat push cooldown ─────────────────────────
//
// Same group keeps trending and the renderer keeps re-pushing the same
// card every 15-min scan, drowning the user in duplicates. We mute
// re-pushes UNLESS something materially changed since the last push:
//   1. NEW CHAIN: a chain joined the cluster (was eth+sol, now eth+sol+bsc)
//   2. SMART_GREW: max smart-money buys on any member jumped ≥ +10
//   3. CHG1H_DOUBLED: max chg1h doubled AND is now ≥ 50% (so trivial
//      moves like 3% → 7% don't trigger)
//   4. COOLDOWN_EXPIRED: ≥ 6h since last push — periodic refresh in
//      case the user lost the old message
//
// State is keyed by group.key (normalized symbol). Cluster identity is
// the symbol — chain composition is tracked separately so a new chain
// joining counts as a change, not a new group.

const COPYCAT_COOLDOWN_HOURS = 6;
const COPYCAT_SMART_DELTA = 10;        // min smart-money increase
const COPYCAT_CHG1H_MIN_ABS = 50;      // chg1h must be at least this big in absolute terms
const COPYCAT_CHG1H_MULT = 2;          // …AND ≥ this multiple of prior

function chainsSig(g: CopycatGroup): string {
  return Array.from(new Set(g.chains.map((c) => String(c).toLowerCase()))).sort().join(",");
}

function groupMaxSmart(g: CopycatGroup): number {
  return g.members.reduce(
    (m, mem) => Math.max(m, (mem.smart_degen_count ?? 0) + (mem.renowned_count ?? 0)),
    0,
  );
}

function groupMaxChg1h(g: CopycatGroup): number {
  return g.members.reduce((m, mem) => Math.max(m, Number(mem.chg1h ?? 0)), 0);
}

interface CopycatPushRow {
  key: string;
  chains_sig: string;
  max_smart_buys: number;
  max_chg1h: number;
  last_pushed_at: Date;
}

async function applyCopycatCooldown(groups: CopycatGroup[]): Promise<CopycatGroup[]> {
  if (groups.length === 0) return groups;

  let priorMap = new Map<string, CopycatPushRow>();
  try {
    const keys = groups.map((g) => g.key);
    const { rows } = await db.query(
      `SELECT key, chains_sig, max_smart_buys, max_chg1h, last_pushed_at
         FROM copycat_pushes
         WHERE key = ANY($1::text[])`,
      [keys],
    );
    priorMap = new Map(rows.map((r: any) => [r.key, {
      key: r.key,
      chains_sig: r.chains_sig,
      max_smart_buys: Number(r.max_smart_buys),
      max_chg1h: Number(r.max_chg1h),
      last_pushed_at: new Date(r.last_pushed_at),
    }]));
  } catch (e) {
    // Table missing or DB hiccup → fail open (let groups through).
    // Better to over-push than to silently lose alerts.
    console.error("[scan:meme] copycat cooldown query failed; allowing all:", e);
    return groups;
  }

  const now = Date.now();
  const allowed: CopycatGroup[] = [];
  const upserts: Array<{
    key: string; display_name: string; chains_sig: string;
    max_smart_buys: number; max_chg1h: number; members_count: number; reason: string;
  }> = [];

  for (const g of groups) {
    const sig = chainsSig(g);
    const maxSmart = groupMaxSmart(g);
    const maxChg = groupMaxChg1h(g);
    const prior = priorMap.get(g.key);

    let reason: string | null = null;
    if (!prior) {
      reason = "first_push";
    } else {
      const priorChains = new Set(prior.chains_sig.split(",").filter(Boolean));
      const currentChains = sig.split(",").filter(Boolean);
      const newChain = currentChains.some((c) => !priorChains.has(c));
      const smartGrew = maxSmart >= prior.max_smart_buys + COPYCAT_SMART_DELTA;
      const chgDoubled = maxChg >= COPYCAT_CHG1H_MIN_ABS
                       && maxChg >= prior.max_chg1h * COPYCAT_CHG1H_MULT;
      const ageHours = (now - prior.last_pushed_at.getTime()) / 3_600_000;
      const cooldownExpired = ageHours >= COPYCAT_COOLDOWN_HOURS;

      if (newChain) reason = "new_chain";
      else if (smartGrew) reason = "smart_grew";
      else if (chgDoubled) reason = "chg1h_doubled";
      else if (cooldownExpired) reason = "cooldown_expired";
    }

    if (reason) {
      allowed.push(g);
      upserts.push({
        key: g.key,
        display_name: g.display_name,
        chains_sig: sig,
        max_smart_buys: maxSmart,
        max_chg1h: maxChg,
        members_count: g.members.length,
        reason,
      });
    } else {
      const ageMin = prior ? Math.round((now - prior.last_pushed_at.getTime()) / 60_000) : 0;
      console.log(
        `[scan:meme] copycat muted: ${g.display_name} (${sig}) — last pushed ${ageMin}m ago, ` +
        `smart ${maxSmart} vs prior ${prior?.max_smart_buys}, chg1h ${maxChg.toFixed(1)}% vs ${prior?.max_chg1h.toFixed(1)}%`,
      );
    }
  }

  // Persist push state for everything we just allowed. Do this BEFORE
  // the actual Telegram send so that a redrive of the same scan won't
  // double-push. Trade-off: a Telegram failure leaves us thinking we
  // pushed, suppressing this group for ≤ 6h. Acceptable — sends rarely
  // fail and the user re-views via the /scan log.
  for (const u of upserts) {
    try {
      await db.query(
        `INSERT INTO copycat_pushes
           (key, display_name, chains_sig, max_smart_buys, max_chg1h, members_count, last_push_reason, last_pushed_at, push_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), 1)
         ON CONFLICT (key) DO UPDATE SET
           display_name     = EXCLUDED.display_name,
           chains_sig       = EXCLUDED.chains_sig,
           max_smart_buys   = EXCLUDED.max_smart_buys,
           max_chg1h        = EXCLUDED.max_chg1h,
           members_count    = EXCLUDED.members_count,
           last_push_reason = EXCLUDED.last_push_reason,
           last_pushed_at   = NOW(),
           push_count       = copycat_pushes.push_count + 1`,
        [u.key, u.display_name, u.chains_sig, u.max_smart_buys, u.max_chg1h, u.members_count, u.reason],
      );
    } catch (e) {
      console.error(`[scan:meme] copycat upsert failed for ${u.key}:`, e);
    }
  }

  if (allowed.length < groups.length) {
    console.log(
      `[scan:meme] copycat cooldown: ${allowed.length}/${groups.length} groups passed ` +
      `(reasons: ${upserts.map((u) => `${u.key}=${u.reason}`).join(", ")})`,
    );
  }
  return allowed;
}

// ── token_analyses db ─────────────────────────────────────────

interface AnalysisRow {
  chain: string;
  address: string;
  symbol: string | null;
  narrative_what_is: string | null;
  narrative_direction: string | null;
  recent_reason: string | null;
  discussion_count: number;
  heat_score: number;
  latest_anomaly_score: number | null;
  anomaly_history: HistoryPoint[];
  no_discussion_strikes: number;
  passed: boolean;
  processed_tweet_ids: string[];
  first_seen_at: Date;
  last_analyzed_at: Date | null;
  analyzed_count: number;
}

async function loadAnalyses(keys: Array<{ chain: string; address: string }>): Promise<Map<string, AnalysisRow>> {
  const out = new Map<string, AnalysisRow>();
  if (keys.length === 0) return out;
  try {
    const chains = keys.map((k) => k.chain);
    const addrs = keys.map((k) => k.address);
    const { rows } = await db.query(
      `SELECT * FROM token_analyses
         WHERE (chain, address) IN (
           SELECT unnest($1::text[]), unnest($2::text[])
         )`,
      [chains, addrs],
    );
    for (const r of rows as any[]) {
      out.set(`${r.chain}:${r.address}`, {
        ...r,
        discussion_count: Number(r.discussion_count ?? 0),
        heat_score: Number(r.heat_score ?? 0),
        latest_anomaly_score: r.latest_anomaly_score == null ? null : Number(r.latest_anomaly_score),
        anomaly_history: Array.isArray(r.anomaly_history) ? r.anomaly_history : [],
        processed_tweet_ids: Array.isArray(r.processed_tweet_ids) ? r.processed_tweet_ids : [],
      });
    }
  } catch (e) {
    console.error("[meme_scan] loadAnalyses failed:", e);
  }
  return out;
}

async function upsertAnalysis(row: {
  chain: string;
  address: string;
  symbol?: string | null;
  narrative_what_is?: string | null;
  narrative_direction?: string | null;
  recent_reason?: string | null;
  discussion_count: number;
  heat_score: number;
  latest_anomaly_score: number;
  anomaly_history: HistoryPoint[];
  no_discussion_strikes: number;
  passed: boolean;
  processed_tweet_ids: string[];
  last_price: number | null;
  last_market_cap: number | null;
  last_liquidity: number | null;
  last_safety?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.query(
      `INSERT INTO token_analyses
         (chain, address, symbol,
          narrative_what_is, narrative_direction, recent_reason,
          discussion_count, heat_score,
          latest_anomaly_score, anomaly_history,
          no_discussion_strikes, passed,
          processed_tweet_ids,
          last_price, last_market_cap, last_liquidity,
          last_safety,
          last_analyzed_at, analyzed_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, NOW(), 1)
       ON CONFLICT (chain, address) DO UPDATE SET
         symbol = COALESCE(EXCLUDED.symbol, token_analyses.symbol),
         narrative_what_is = COALESCE(EXCLUDED.narrative_what_is, token_analyses.narrative_what_is),
         narrative_direction = COALESCE(EXCLUDED.narrative_direction, token_analyses.narrative_direction),
         recent_reason = COALESCE(EXCLUDED.recent_reason, token_analyses.recent_reason),
         discussion_count = EXCLUDED.discussion_count,
         heat_score = EXCLUDED.heat_score,
         latest_anomaly_score = EXCLUDED.latest_anomaly_score,
         anomaly_history = EXCLUDED.anomaly_history,
         no_discussion_strikes = EXCLUDED.no_discussion_strikes,
         passed = EXCLUDED.passed,
         processed_tweet_ids = EXCLUDED.processed_tweet_ids,
         last_price = EXCLUDED.last_price,
         last_market_cap = EXCLUDED.last_market_cap,
         last_liquidity = EXCLUDED.last_liquidity,
         last_safety = COALESCE(EXCLUDED.last_safety, token_analyses.last_safety),
         last_analyzed_at = NOW(),
         analyzed_count = token_analyses.analyzed_count + 1`,
      [
        row.chain, row.address, row.symbol ?? null,
        row.narrative_what_is ?? null, row.narrative_direction ?? null, row.recent_reason ?? null,
        row.discussion_count, row.heat_score,
        row.latest_anomaly_score, JSON.stringify(row.anomaly_history),
        row.no_discussion_strikes, row.passed,
        row.processed_tweet_ids,
        row.last_price, row.last_market_cap, row.last_liquidity,
        row.last_safety ? JSON.stringify(row.last_safety) : null,
      ],
    );
  } catch (e) {
    console.error(`[meme_scan] upsert ${row.chain}/${row.address}:`, e);
  }
}

// ── Tweet → TweetLike + filter ────────────────────────────────

function tweetsToFiltered(raw: TwitterSearchTweet[], processed: Set<string>): {
  kept: Array<TweetLike & { tweet_id: string; text: string; created_at_ms: number | null; raw_text: string }>;
  dropped: { bot: number; small_account: number; already_processed: number };
} {
  const kept: any[] = [];
  const dropped = { bot: 0, small_account: 0, already_processed: 0 };
  for (const t of raw) {
    const id = String(t.tweet_id ?? t.id ?? "");
    if (!id) continue;
    if (processed.has(id)) { dropped.already_processed++; continue; }
    const followers = Number(t.user?.followers_count ?? 0);
    if (followers <= MIN_AUTHOR_FOLLOWERS) { dropped.small_account++; continue; }
    if (isBotTweet(t)) { dropped.bot++; continue; }
    const ttMs = tweetTs(t);
    kept.push({
      tweet_id: id,
      screen_name: t.user?.screen_name,
      followers,
      favorite_count: t.favorite_count,
      reply_count: t.reply_count,
      retweet_count: t.retweet_count,
      quote_count: t.quote_count,
      created_at_ms: ttMs,
      text: String(t.text ?? "").slice(0, 500),
      raw_text: String(t.text ?? ""),
    });
  }
  return { kept, dropped };
}

// ── Per-candidate processing ──────────────────────────────────

interface CandidateOutput {
  chain: string;
  symbol: string;
  address: string;
  price: number;
  chg1h: number;
  market_cap: number;
  liquidity: number;
  age_h: number | null;

  // Persisted analysis
  narrative_what_is: string | null;
  narrative_direction: string | null;
  recent_reason: string | null;

  // Computed
  discussion_count: number;
  heat_score: number;
  anomaly_score: number;
  anomaly_delta: number;
  continuing_up: boolean;
  star: number;

  // Smart-money signals (passed through from gmgn for alert scoring)
  smart_degen_count: number;
  renowned_count: number;

  // AI-judged catalyst impact (1-10) — primary signal for alert tier.
  // Combines event significance + observed discussion velocity.
  catalyst_impact: number;

  // Alert tier — quality gate
  //   "🔥" = BOAR-grade signal: smart money + real pump + specific narrative
  //   ""   = below alert threshold; recorded in brain but not pushed to chat
  alert_tier: "🔥" | "";
  alert_score: number;
  alert_reasons: string[];

  // Alert category — type gate. User explicitly wants only these three:
  //   "zombie"     — 老币复活：首次进入视野且合约 > 30 天（休眠后激活）
  //   "new"        — 新币拉高：首次进入视野且合约 < 72h
  //   "continuing" — 持续上升：已分析过且 anomaly continuing_up=true
  //   ""           — 其他（noise，不推送）
  // Telegram only pushes when (alert_tier=🔥 AND alert_category != "").
  alert_category: "zombie" | "new" | "continuing" | "";

  // Flags
  is_known: boolean;                // existed in token_analyses before this scan
  tweet_hits: number;               // raw tweet count from xapi (for debugging)
  tweet_kept: number;               // after follower/bot/dedup filter
  web_hits: number;                 // google results count
  fresh_tweets: number;             // tweets that triggered a new analyze call
  passed: boolean;                  // 3-strikes fired THIS scan
}

/**
 * Detect whether the analyzer's recent_reason explicitly quotes a
 * high-follower KOL. The analyzer prompt instructs it to format
 * citations as "@handle（X 粉, Yh 前）"  — the (X 粉) pattern is the
 * tell. A cite from anyone ≥ 5K followers means a real explanatory
 * tweet was found.
 *
 * Why this matters: at T0 of a catalyst (e.g. BOAR when @0xmoles
 * first tweeted "Nikita 换 banner"), price is barely moving and no
 * smart money has piled in yet — but THE EXPLANATION IS ALREADY
 * PUBLIC. That single high-follower tweet IS the signal. We need to
 * surface tokens at this exact early window, not after the pump.
 */
function detectKolExplanation(reason: string): { found: boolean; maxFollowers: number } {
  if (!reason) return { found: false, maxFollowers: 0 };
  // Matches "(2259 粉" / "(23k 粉" / "（2.3万粉" with optional comma/space
  const rx = /[（(]\s*([\d.]+)\s*([kKw万千]?)\s*粉/g;
  let max = 0;
  let m: RegExpExecArray | null;
  while ((m = rx.exec(reason)) !== null) {
    const n = parseFloat(m[1]);
    const suffix = (m[2] || "").toLowerCase();
    let n_abs = n;
    if (suffix === "k") n_abs = n * 1_000;
    else if (suffix === "w" || suffix === "万") n_abs = n * 10_000;
    else if (suffix === "千") n_abs = n * 1_000;
    if (n_abs > max) max = n_abs;
  }
  return { found: max > 0, maxFollowers: max };
}

/**
 * "BOAR-grade" alert score. Multi-signal scoring; the strongest single
 * lever is "did a credible KOL publicly explain the catalyst?" — that
 * fires at T0, before price moves and before smart money piles in. The
 * other signals (smart money, pump %, discussion volume) corroborate
 * later in the cycle but aren't required for an early alert.
 *
 * honeypot / rug / wash-trading → score forced to 0.
 *
 * Threshold to push: score ≥ 7.
 *   At BOAR T0 (only @0xmoles 23k tweet, chg1h~12, smart=0): ~9 ✅
 *   At BOAR mid-pump (smart=3, kol=2, chg1h=78, disc 1500): ~17 ✅
 *   Pump-only no-narrative shitcoin: 1-3 ❌
 */
/**
 * Categorize the candidate into one of the three types the user wants
 * to be alerted about. Anything outside these three is noise.
 *
 *   - zombie    : first sight + contract age > 30d. Old contract just
 *                 activated. Pattern: Michael Jackson, w🍖 — sleeping
 *                 zombies that suddenly pump on a fresh catalyst.
 *   - new       : first sight + contract age < 72h. Pure pump.fun /
 *                 Raydium / pumpswap fresh deployments.
 *   - continuing: already-known + anomaly_score still rising or
 *                 sustained above STILL_PUMPING_SCORE.
 */
function categorizeCandidate(c: CandidateOutput): CandidateOutput["alert_category"] {
  const ageH = Number(c.age_h ?? 0);
  if (c.is_known && c.continuing_up) return "continuing";
  if (!c.is_known) {
    if (ageH > 0 && ageH < 72) return "new";
    if (ageH >= 24 * 30) return "zombie";
  }
  return "";
}

// Match the catch-all "no-catalyst" disclaimer the analyzer falls back
// to when it can't find evidence. Used both in per-token alert gating
// and copycat suppression.
const NO_CATALYST_RX = /近\s*7\s*天.*未发现|未发现新催化|未发现明确催化|未发现.*催化/;

function computeAlertTier(c: CandidateOutput, source: any): { tier: "🔥" | ""; score: number; reasons: string[] } {
  const reasons: string[] = [];

  if (Number(source.is_honeypot ?? 0) === 1) return { tier: "", score: 0, reasons: ["honeypot 屏蔽"] };
  if (Number(source.rug_ratio ?? 0) > 0.5) return { tier: "", score: 0, reasons: ["rug>0.5 屏蔽"] };
  if (source.is_wash_trading === true) return { tier: "", score: 0, reasons: ["wash-trading 屏蔽"] };

  let score = 0;
  const smart = Number(source.smart_degen_count ?? 0);
  const kol = Number(source.renowned_count ?? 0);

  // ★★★ AI-judged catalyst impact (1-10). This is the most important
  // single signal because the AI sees both the event's intrinsic level
  // (who/what is involved) AND the discussion volume / KOL fan-in
  // patterns simultaneously. A 9+ score from the AI alone should
  // basically guarantee an alert.
  const impact = Number(c.catalyst_impact ?? 5);
  if (impact >= 9) { score += 6; reasons.push(`AI影响=${impact}`); }
  else if (impact >= 7) { score += 4; reasons.push(`AI影响=${impact}`); }
  else if (impact >= 5) { score += 1; reasons.push(`AI影响=${impact}`); }
  // impact ≤ 4 contributes 0 — keeps the threshold honest

  // ★★★ KOL explanation — the early-T0 signal that catches BOAR-style
  // catalysts before they fully pump. Tiered by follower size of the
  // largest cited KOL.
  const kolExplain = detectKolExplanation(c.recent_reason ?? "");
  if (kolExplain.maxFollowers >= 50_000) {
    score += 6;
    reasons.push(`KOL解释(${(kolExplain.maxFollowers / 1000).toFixed(0)}k粉)`);
  } else if (kolExplain.maxFollowers >= 10_000) {
    score += 5;
    reasons.push(`KOL解释(${(kolExplain.maxFollowers / 1000).toFixed(0)}k粉)`);
  } else if (kolExplain.maxFollowers >= 2_000) {
    score += 3;
    reasons.push(`KOL解释(${(kolExplain.maxFollowers / 1000).toFixed(1)}k粉)`);
  } else if (kolExplain.found) {
    score += 1;
    reasons.push(`小号解释`);
  }

  // Smart money on-chain
  if (smart >= 3) { score += 3; reasons.push(`smart=${smart}`); }
  else if (smart >= 1) { score += 1; reasons.push(`smart=${smart}`); }
  if (kol >= 2) { score += 3; reasons.push(`kol=${kol}`); }
  else if (kol >= 1) { score += 1; reasons.push(`kol=${kol}`); }

  // Pump magnitude
  const ach1h = Math.abs(c.chg1h);
  if (ach1h >= 50) { score += 2; reasons.push(`chg1h=${c.chg1h.toFixed(0)}%`); }
  else if (ach1h >= 20) { score += 1; reasons.push(`chg1h=${c.chg1h.toFixed(0)}%`); }

  // Discussion volume — proxy for community attention build-up
  if (c.discussion_count >= 500) { score += 3; reasons.push(`disc=${c.discussion_count.toFixed(0)}`); }
  else if (c.discussion_count >= 100) { score += 2; reasons.push(`disc=${c.discussion_count.toFixed(0)}`); }
  else if (c.discussion_count >= 30) { score += 1; reasons.push(`disc=${c.discussion_count.toFixed(0)}`); }

  // Specific narrative present (non-template, non-disclaimer)
  const reason = c.recent_reason ?? "";
  const hasSpecific = reason.length >= 10
    && !containsStaleMarker(reason)
    && !NO_CATALYST_RX.test(reason);
  if (hasSpecific) { score += 2; reasons.push("具体涨因"); }

  // Tiny-mcap penalty: dust tokens (< $100K) are pump.fun degens. Even
  // with 🔥-grade scoring elsewhere, if there's no smart money + no KOL
  // citation pulled by detectKolExplanation, force-mute. Stops alerts
  // like XCHAT @ $43K and alun @ $177K with smart=0/kol=0 from firing.
  if (c.market_cap < 100_000 && smart === 0 && kol === 0 && kolExplain.maxFollowers < 5_000) {
    return { tier: "", score: Math.min(score, 4), reasons: [...reasons, `微盘<\$100K无背书静音(mcap=\$${(c.market_cap/1000).toFixed(0)}K)`] };
  }

  // Hard penalty: if the LLM's recent_reason is an explicit "no
  // catalyst" disclaimer, force the score below threshold so it never
  // pushes — UNLESS the token is a fresh new launch with serious
  // momentum + meaningful market cap. That's the SCAM-on-sol case the
  // user pointed out: brand-new pump.fun deployment, mcap $4M+, chg5m
  // ≈ +30%, no catalyst tweet yet because it's literally too new for
  // anyone to have written one. Worth alerting once.
  if (NO_CATALYST_RX.test(reason)) {
    const ageH = Number(c.age_h ?? 99999);
    const c5Signed = Number(source.chg5m ?? 0);          // signed — penalize crashes
    const c5 = Math.abs(c5Signed);
    const c1 = Math.abs(c.chg1h);
    const inWindow = !c.is_known && ageH > 0 && ageH < 72;
    // ALL fresh-launch exceptions now require:
    //   - mcap ≥ $200K  (no pump.fun dust under $200K, ever)
    //   - chg5m > -10%  (not currently in a crash; +521% 1h is meaningless
    //                    if 5m is already -19% — pump-and-dump topping)
    const mcapFloor = c.market_cap >= 200_000;
    const notCrashing = c5Signed > -10;
    // Branch A: established-mcap fresh launch (≥$1M, the SCAM @ T0 case)
    const branchA = inWindow && mcapFloor && c.market_cap >= 1_000_000 &&
                    notCrashing && (c5 >= 30 || c1 >= 50);
    // Branch B: extreme pump on $200K-$1M mcap (the LUCA case — but now
    // requires the 5m direction to confirm pump still in progress).
    const branchB = inWindow && mcapFloor && notCrashing && (c1 >= 200 || c5Signed >= 80);
    if (!branchA && !branchB) {
      return { tier: "", score: Math.min(score, 4), reasons: [...reasons, "无催化-强制静音"] };
    }
    score += 5;
    if (branchB && !branchA) {
      reasons.push(`新币极端动量豁免(chg1h=${c1.toFixed(0)}%, mcap=$${(c.market_cap / 1_000).toFixed(0)}K, chg5m=${c5Signed.toFixed(0)}%, age=${ageH.toFixed(1)}h)`);
    } else {
      reasons.push(`新币动量豁免(mcap=$${(c.market_cap / 1_000_000).toFixed(1)}M, chg5m=${c5.toFixed(0)}%, age=${ageH.toFixed(1)}h)`);
    }
  }

  return { tier: score >= 7 ? "🔥" : "", score, reasons };
}

// ── Phase A (per-candidate, parallel): fetch xapi + filter, NO LLM call ──

interface PreparedCandidate {
  source: any;
  prior: AnalysisRow | undefined;
  curScore: number;
  delta: ReturnType<typeof anomalyDelta>;
  newHistory: HistoryPoint[];
  twitter_hits_raw: TwitterSearchTweet[];
  web_hits_arr: WebSearchHit[];
  freshTweets: ReturnType<typeof tweetsToFiltered>["kept"];
  shouldAnalyze: boolean;
}

// Phrases the analyzer prompt now forbids — any prior containing one of
// these was written by the old lazy prompt and must be re-analyzed even
// if its anomaly delta says "not continuing up". Keep short and literal;
// overlap with nuanced phrasing is OK since we're erring toward redo.
const STALE_NARRATIVE_MARKERS = [
  "社区炒作",
  "纯炒作",
  "情绪驱动",
  "模因币炒作",
  "meme币炒作",
  "上的meme币",          // "BSC上的meme币"/"Base上的meme币"/"Solana上的meme币"
  "上的Meme币",
  "生态Meme币",          // "BSC生态Meme币"
  "生态meme币",
  "跌幅，无具体原因",
  "涨幅，无具体原因",
  // New (user feedback: vague summaries are banned — force redo):
  "相关讨论",             // "XX项目相关讨论"
  "相关叙事",             // "XX项目相关叙事"
  "相关代币",             // "XX项目相关代币"
  "相关炒作",
  "相关新闻",             // "XX项目相关新闻"
  "相关事件",             // "XX相关事件"
  "相关活动",
  "相关消息",
  "讨论和交易活跃",
  "讨论活跃",
  "交易活跃",
  "话题活跃",
  "社区关注",             // "社区关注"
  "市场关注",
  "持续关注",
  // Soft-fail markers from the analyzer when it gave up:
  "材料不足",             // covers "材料不足，需继续观察" / "材料不足" alone
  "需继续观察",
];

function containsStaleMarker(s: string | null | undefined): boolean {
  if (!s) return false;
  const norm = s.toLowerCase();
  return STALE_NARRATIVE_MARKERS.some((m) => norm.includes(m.toLowerCase()));
}

/**
 * A prior row exists but its narrative is unusable — either all three
 * fields are null (analyzer never succeeded) OR any field is a known
 * low-effort template answer from the old prompt. Either way, force
 * the analyzer on this scan so we replace the junk.
 */
function neverSuccessfullyAnalyzed(prior: AnalysisRow | undefined): boolean {
  if (!prior) return false;
  const allNull = !prior.narrative_what_is && !prior.narrative_direction && !prior.recent_reason;
  if (allNull) return true;
  return (
    containsStaleMarker(prior.narrative_what_is) ||
    containsStaleMarker(prior.narrative_direction) ||
    containsStaleMarker(prior.recent_reason)
  );
}

/**
 * Build a richer web-search query so we capture narrative hints in
 * BOTH English and Chinese, plus include the project's own domain if
 * gmgn gave us one (often the landing page states the catalyst).
 */
function buildWebQuery(source: any): string {
  const s = String(source.symbol ?? "").trim();
  const parts: string[] = [];
  if (s) parts.push(`"${s}"`);
  parts.push("(crypto OR token OR meme OR 币 OR 代币 OR 叙事 OR catalyst)");
  if (source.website) {
    try {
      const host = new URL(String(source.website).startsWith("http") ? source.website : `https://${source.website}`).hostname;
      if (host) parts.push(`OR site:${host}`);
    } catch { /* skip bad URLs */ }
  }
  return parts.join(" ");
}

async function prepareCandidate(source: any, prior: AnalysisRow | undefined): Promise<PreparedCandidate | null> {
  const { chain, address } = source;
  if (!chain || !address) return null;

  const curScore = anomalyScore({
    chg1h: source.chg1h, chg24h: source.chg24h, chg5m: source.chg5m, volume_ratio: null,
  });
  const history = prior?.anomaly_history ?? [];
  const delta = anomalyDelta(history, curScore, {
    chg1h: source.chg1h,
    chg5m: source.chg5m,
  });
  const newPoint: HistoryPoint = {
    ts: new Date().toISOString(),
    chg1h: source.chg1h ?? null,
    chg24h: source.chg24h ?? null,
    chg5m: source.chg5m ?? null,
    score: curScore,
  };
  const newHistory = [...history, newPoint].slice(-10);

  const firstTime = !prior || neverSuccessfullyAnalyzed(prior);

  // Dedup-bypass: if the prior is stale (template answer / null narrative),
  // we want the analyzer to retry on the LATEST tweet pool — even if those
  // tweet IDs were already processed. Otherwise the analyzer never gets
  // material to work with and the "材料不足" prior gets carried forever.
  const processedSet = firstTime
    ? new Set<string>()
    : new Set<string>(prior?.processed_tweet_ids ?? []);
  const needWebSearch = firstTime || delta.continuing_up || delta.is_spiking;
  const twitterHandle = (source.twitter ?? "").replace(/^@/, "").trim();

  // Three parallel fetches:
  //   1. Tweets mentioning the full CA (noisy, but finds KOL / community)
  //   2. Tweets FROM the project's own account (describes what the coin is)
  //   3. Web search with multi-lingual OR query (covers EN/ZH narrative)
  const [ca_hits, handle_hits, web_hits_arr] = await Promise.all([
    xapiTwitterSearch(address),
    twitterHandle ? xapiTwitterSearch(`from:${twitterHandle}`, "Latest") : Promise.resolve([] as TwitterSearchTweet[]),
    needWebSearch ? xapiWebSearch(buildWebQuery(source)) : Promise.resolve([] as WebSearchHit[]),
  ]);

  // Merge + dedup by tweet_id, then sort newest-first so the analyzer's
  // top-5 slice gets the most recent evidence (recent_reason must cite
  // fresh events, not evergreen narrative).
  const seen = new Set<string>();
  const merged: TwitterSearchTweet[] = [];
  for (const t of [...handle_hits, ...ca_hits]) {
    const id = String(t.tweet_id ?? t.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    merged.push(t);
  }
  merged.sort((a, b) => {
    const ta = Date.parse(a.created_at ?? "") || 0;
    const tb = Date.parse(b.created_at ?? "") || 0;
    return tb - ta;  // newest first
  });
  const twitter_hits_raw = merged;

  // Web hits too: parse dates and prefer fresher. xapi's web.search is
  // already relevance-sorted by Google, but we want time-skewed for
  // recent_reason, so stable-re-sort: dated hits newest-first, undated
  // keep original order after.
  web_hits_arr.sort((a, b) => {
    const ta = a.date ? Date.parse(a.date) || 0 : 0;
    const tb = b.date ? Date.parse(b.date) || 0 : 0;
    if (ta === 0 && tb === 0) return 0;       // both undated: keep order
    if (ta === 0) return 1;                   // undated goes after
    if (tb === 0) return -1;
    return tb - ta;                           // newest first
  });

  const { kept: freshTweets } = tweetsToFiltered(twitter_hits_raw, processedSet);
  const shouldAnalyze = (firstTime || delta.continuing_up || delta.is_spiking)
    && (freshTweets.length > 0 || web_hits_arr.length > 0);

  return { source, prior, curScore, delta, newHistory, twitter_hits_raw, web_hits_arr, freshTweets, shouldAnalyze };
}

// ── Phase C (per-candidate): compute metrics + persist + build output ──

/**
 * Snapshot raw safety + market fields from a gmgn/GT source row. The
 * premium module reads this from token_analyses.last_safety to apply
 * its hard-gate filter (single-maker, honeypot, dev-hold) without
 * re-fetching gmgn. Keep keys stable — the filter and reflector both
 * rely on this exact shape.
 */
function buildSafetySnapshot(source: any): Record<string, unknown> {
  return {
    smart_degen_count: Number(source?.smart_degen_count ?? 0),
    renowned_count: Number(source?.renowned_count ?? 0),
    holder_count: Number(source?.holder_count ?? source?.holders ?? 0),
    age_h: source?.age_h ?? null,
    dev_team_hold_rate: Number(source?.dev_team_hold_rate ?? 0),
    bundler_rate: Number(source?.bundler_rate ?? 0),
    is_honeypot: Number(source?.is_honeypot ?? 0),
    rug_ratio: Number(source?.rug_ratio ?? 0),
    chg5m: Number(source?.chg5m ?? 0),
    chg1h: Number(source?.chg1h ?? 0),
    volume_h1: Number(source?.volume ?? source?.volume_h1 ?? 0),
    swaps_h1: Number(source?.swaps ?? source?.swaps_h1 ?? 0),
    liquidity: Number(source?.liquidity ?? 0),
    market_cap: Number(source?.market_cap ?? 0),
    price: Number(source?.price ?? 0),
    snapshot_at: new Date().toISOString(),
    source: source?.source ?? source?.feed ?? "gmgn",
  };
}

async function finalizeCandidate(prep: PreparedCandidate, answers: ThreeAnswers | null): Promise<CandidateOutput> {
  const { source, prior, curScore, delta, newHistory, twitter_hits_raw, web_hits_arr, freshTweets } = prep;
  const { chain, address, symbol } = source;
  const nowMs = Date.now();
  const safety = buildSafetySnapshot(source);

  const hasAnyDiscussion = freshTweets.length > 0 || web_hits_arr.length > 0 || (prior?.discussion_count ?? 0) > 0;

  // 3-strike pass
  if (!hasAnyDiscussion) {
    const strikes = (prior?.no_discussion_strikes ?? 0) + 1;
    const willPass = strikes >= STRIKES_TO_PASS;
    await upsertAnalysis({
      chain, address, symbol: symbol ?? prior?.symbol ?? null,
      narrative_what_is: prior?.narrative_what_is ?? null,
      narrative_direction: prior?.narrative_direction ?? null,
      recent_reason: prior?.recent_reason ?? null,
      discussion_count: prior?.discussion_count ?? 0,
      heat_score: prior ? decayStoredHeat(prior.heat_score, prior.last_analyzed_at?.getTime() ?? nowMs, nowMs) : 0,
      latest_anomaly_score: curScore,
      anomaly_history: newHistory,
      no_discussion_strikes: strikes, passed: willPass,
      processed_tweet_ids: prior?.processed_tweet_ids ?? [],
      last_price: Number(source.price ?? 0),
      last_market_cap: Number(source.market_cap ?? 0),
      last_liquidity: Number(source.liquidity ?? 0),
      last_safety: safety,
    });
    const base: CandidateOutput = {
      chain, symbol: symbol ?? "?", address,
      price: Number(source.price ?? 0),
      chg1h: Number(source.chg1h ?? 0),
      market_cap: Number(source.market_cap ?? 0),
      liquidity: Number(source.liquidity ?? 0),
      age_h: source.age_h ?? null,
      narrative_what_is: prior?.narrative_what_is ?? null,
      narrative_direction: prior?.narrative_direction ?? null,
      recent_reason: prior?.recent_reason ?? null,
      discussion_count: prior?.discussion_count ?? 0,
      heat_score: 0,
      anomaly_score: curScore,
      anomaly_delta: delta.delta,
      continuing_up: delta.continuing_up,
      star: 0,
      smart_degen_count: Number(source.smart_degen_count ?? 0),
      renowned_count: Number(source.renowned_count ?? 0),
      catalyst_impact: 5,                  // no analyzer call → neutral default
      alert_tier: "",
      alert_score: 0,
      alert_reasons: [],
      alert_category: "",
      is_known: !!prior,
      tweet_hits: twitter_hits_raw.length, tweet_kept: 0,
      web_hits: web_hits_arr.length, fresh_tweets: 0,
      passed: willPass,
    };
    const a = computeAlertTier(base, source);
    base.alert_tier = a.tier;
    base.alert_score = a.score;
    base.alert_reasons = a.reasons;
    base.alert_category = categorizeCandidate(base);
    return base;
  }

  // heat + discussion compute
  const freshTweetLikes: TweetLike[] = freshTweets.map((t) => ({
    screen_name: t.screen_name,
    followers: t.followers,
    favorite_count: t.favorite_count,
    reply_count: t.reply_count,
    retweet_count: t.retweet_count,
    quote_count: t.quote_count,
    created_at_ms: t.created_at_ms ?? undefined,
  }));
  const freshHeat = heatScore(freshTweetLikes, nowMs);
  const freshDiscussion = discussionCount(freshTweetLikes);
  const priorDecayed = prior
    ? decayStoredHeat(prior.heat_score, prior.last_analyzed_at?.getTime() ?? nowMs, nowMs)
    : 0;
  const totalHeat = priorDecayed + freshHeat;
  const totalDiscussion = (prior?.discussion_count ?? 0) + freshDiscussion.total;

  const new_what_is = answers?.what_is ?? prior?.narrative_what_is ?? null;
  const new_direction = answers?.narrative_direction ?? prior?.narrative_direction ?? null;
  const new_reason = answers?.recent_reason ?? prior?.recent_reason ?? null;

  const processedSet = new Set<string>(prior?.processed_tweet_ids ?? []);
  const updatedProcessedIds = [...processedSet, ...freshTweets.map((t) => t.tweet_id)].slice(-500);

  await upsertAnalysis({
    chain, address, symbol: symbol ?? prior?.symbol ?? null,
    narrative_what_is: new_what_is,
    narrative_direction: new_direction,
    recent_reason: new_reason,
    discussion_count: totalDiscussion,
    heat_score: totalHeat,
    latest_anomaly_score: curScore,
    anomaly_history: newHistory,
    no_discussion_strikes: 0, passed: false,
    processed_tweet_ids: updatedProcessedIds,
    last_price: Number(source.price ?? 0),
    last_market_cap: Number(source.market_cap ?? 0),
    last_liquidity: Number(source.liquidity ?? 0),
    last_safety: safety,
  });

  const star = starRating({
    heatScore: totalHeat,
    discussionCount: totalDiscussion,
    anomalyContinuingUp: delta.continuing_up,
    isKnownToken: !!prior,
  });

  const base: CandidateOutput = {
    chain, symbol: symbol ?? "?", address,
    price: Number(source.price ?? 0),
    chg1h: Number(source.chg1h ?? 0),
    market_cap: Number(source.market_cap ?? 0),
    liquidity: Number(source.liquidity ?? 0),
    age_h: source.age_h ?? null,
    narrative_what_is: new_what_is,
    narrative_direction: new_direction,
    recent_reason: new_reason,
    discussion_count: Math.round(totalDiscussion * 100) / 100,
    heat_score: Math.round(totalHeat * 100) / 100,
    anomaly_score: Math.round(curScore * 100) / 100,
    anomaly_delta: Math.round(delta.delta * 100) / 100,
    continuing_up: delta.continuing_up,
    star,
    smart_degen_count: Number(source.smart_degen_count ?? 0),
    renowned_count: Number(source.renowned_count ?? 0),
    catalyst_impact: Number(answers?.catalyst_impact ?? 5),
    alert_tier: "",
    alert_score: 0,
    alert_reasons: [],
    alert_category: "",
    is_known: !!prior,
    tweet_hits: twitter_hits_raw.length,
    tweet_kept: freshTweets.length,
    web_hits: web_hits_arr.length,
    fresh_tweets: freshTweets.length,
    passed: false,
  };
  const a = computeAlertTier(base, source);
  base.alert_tier = a.tier;
  base.alert_score = a.score;
  base.alert_reasons = a.reasons;
  base.alert_category = categorizeCandidate(base);
  return base;
}

// ── Top-level tool ─────────────────────────────────────────────

export const memeScanTool = defineJsonTool({
  name: "meme_scan",
  label: "meme scan",
  description:
    "Complete meme discovery pipeline in ONE call. Fetches each chain's top-10 movers (gmgn sol/base/bsc + ave eth), hard-filters obvious garbage, and for each survivor either INCREMENTALLY updates its persisted token_analyses (if known — carries decay-adjusted heat forward + supplements three-question analysis when anomaly continuing_up) or does a FULL first-analysis (searches twitter CA + google web, runs three-question AI analysis answering 这是什么币/叙事方向/近期涨因, records discussion_count / heat_score / star rating). Tokens with zero discussion across three consecutive scans are auto-passed. Returns ≤15 candidates ranked by heat_score. Main agent should call this once then brain_write_scan.",
  parameters: Type.Object({
    top_per_chain: Type.Optional(Type.Number({ default: TOP_PER_CHAIN, minimum: 3, maximum: 30 })),
  }),
  run: async ({ top_per_chain }) => {
    const perChain = top_per_chain ?? TOP_PER_CHAIN;

    const stats = {
      gmgn_sol: 0, gmgn_base: 0, gmgn_bsc: 0, ave_eth: 0,
      union_before_hardfilter: 0,
      after_hardfilter: 0,
      per_chain_topn: 0,
      known_tokens: 0,
      new_tokens: 0,
      skipped_passed: 0,
      tweet_filter_in: 0,
      tweet_filter_kept: 0,
      analyzer_calls: 0,
      analyzer_success: 0,
      zero_discussion_strikes: 0,
      newly_passed: 0,
    };

    // ── Phase A: chain-by-chain fetch → hardFilter → xapi search ──
    //
    // Serial across chains (per user: "一个链一个链的分析"). hardFilter
    // runs on the chain's tokens BEFORE any xapi call, so we never
    // waste twitter/google queries on honeypots or low-liquidity
    // garbage. Within a chain the xapi fan-out is still parallel.
    function topN(list: any[], n: number) {
      // Composite score for candidate ranking. Two factors:
      //   (a) short-window price anomaly: max(|chg1h|, |chg5m|*3)
      //       — catches tokens pumping RIGHT NOW
      //   (b) smart-money fan-in: log-weighted (smart_degen + kol)
      //       — catches tokens like uPEG that 49+46 smart wallets are
      //       loading up on but whose short-term price is consolidating
      //
      // Without (b), uPEG (gmgn eth #1 by volume, 49 smart + 46 KOL,
      // narrative "OpenSea CMO bought") falls off the topN whenever its
      // chg5m/chg1h cool — even though that on-chain fan-in is the
      // strongest single signal we have access to.
      const compScore = (t: any): number => {
        const a1 = Math.abs(Number(t.chg1h ?? 0));
        const a5 = Math.abs(Number(t.chg5m ?? 0));
        const priceScore = Math.max(a1, a5 * 3);
        const smart = Number(t.smart_degen_count ?? 0);
        const kol = Number(t.renowned_count ?? 0);
        // log10(0+1)=0, log10(10)=1, log10(100)=2 → 5×log10 caps near +10
        const smartScore = Math.log10(smart + kol + 1) * 5;
        return priceScore + smartScore;
      };
      return list.filter(hardFilter)
        .sort((a, b) => compScore(b) - compScore(a))
        .slice(0, n);
    }

    const prepped: PreparedCandidate[] = [];
    const CONCURRENCY = 8;

    // ETH special case: gmgn-cli eth's volume-sorted trending is still
    // blue-chip heavy (wM, aEthWETH at top-2). Pull 30 from gmgn (deep
    // enough to reach meme territory) + GT's pump-biased sorts, then
    // topN() re-ranks by |chg1h| to surface actual movers.
    const ETH_POOL_SIZE = 30;
    const chainFetchers: Array<{ name: string; fetch: () => Promise<any[]> }> = [
      // All chains now go gmgn + GT combined — GT's pump-biased trending
      // catches day-old 5000%-pumpers that gmgn's volume ranking misses
      // on every chain (proven on eth→MEME and sol→uncraft).
      { name: "sol", fetch: () => fetchChainTopCombined("sol", perChain) },
      { name: "base", fetch: () => fetchChainTopCombined("base", perChain) },
      { name: "bsc", fetch: () => fetchChainTopCombined("bsc", perChain) },
      { name: "eth", fetch: () => fetchChainTopCombined("eth", ETH_POOL_SIZE) },
    ];

    for (const { name, fetch: chainFetch } of chainFetchers) {
      const raw = await chainFetch();
      if (name === "sol") stats.gmgn_sol = raw.length;
      else if (name === "base") stats.gmgn_base = raw.length;
      else if (name === "bsc") stats.gmgn_bsc = raw.length;
      else if (name === "eth") stats.ave_eth = raw.length;
      stats.union_before_hardfilter += raw.length;

      // filter first, then xapi search — never hit twitter for garbage
      const survivors = topN(raw, perChain);
      stats.after_hardfilter += survivors.length;
      stats.per_chain_topn += survivors.length;
      if (survivors.length === 0) continue;

      const priorMap = await loadAnalyses(survivors.map((s) => ({ chain: s.chain, address: s.address })));

      for (let i = 0; i < survivors.length; i += CONCURRENCY) {
        const chunk = survivors.slice(i, i + CONCURRENCY);
        const chunkResults = await Promise.all(chunk.map(async (s) => {
          const prior = priorMap.get(`${s.chain}:${s.address}`);
          if (prior?.passed) { stats.skipped_passed++; return null; }
          if (prior) stats.known_tokens++; else stats.new_tokens++;
          return await prepareCandidate(s, prior);
        }));
        for (const r of chunkResults) if (r) prepped.push(r);
      }
    }

    // ── Phase A.5: fast-model tweet filter ──
    //
    // User directive: "推文/搜索信息先经过快速模型按规则过滤掉无用的，
    // 再整合询问". One glm-4-flash call for every tweet across every
    // candidate. Non-useful tweets are dropped BEFORE the 3-question
    // analyzer sees them.
    {
      // Cap per-candidate tweets before the filter. Analyzer only reads
      // the top 5 tweets per token anyway (sorted newest-first from
      // xapi), so filtering more than that is wasted prompt budget
      // and pushes us past the 45s glm-4-flash ceiling.
      const TWEETS_PER_TOKEN_FOR_FILTER = 8;
      const filterInputs: TweetFilterInput[] = [];
      for (const p of prepped) {
        const tokenKey = `${p.source.chain}:${p.source.address}`;
        const slice = p.freshTweets.slice(0, TWEETS_PER_TOKEN_FOR_FILTER);
        for (const t of slice) {
          filterInputs.push({
            id: t.tweet_id,
            token_key: tokenKey,
            symbol: p.source.symbol,
            text: t.raw_text,
            author: t.screen_name,
            followers: t.followers,
          });
        }
        // tweets past the cap pass through untouched (kept as-is)
      }
      stats.tweet_filter_in = filterInputs.length;

      if (filterInputs.length > 0) {
        const verdicts = await filterUsefulTweets(filterInputs);
        // drop non-useful; verdicts missing → treat as useful (model
        // didn't cover it — don't lose the tweet to LLM flakiness)
        for (const p of prepped) {
          p.freshTweets = p.freshTweets.filter((t) => verdicts.get(t.tweet_id)?.useful !== false);
        }
        const kept = prepped.reduce((n, p) => n + p.freshTweets.length, 0);
        stats.tweet_filter_kept = kept;
        // recompute shouldAnalyze — a candidate with all tweets killed and no web hits no longer needs the analyzer
        for (const p of prepped) {
          const firstTime = !p.prior || neverSuccessfullyAnalyzed(p.prior);
          p.shouldAnalyze = (firstTime || p.delta.continuing_up || p.delta.is_spiking)
            && (p.freshTweets.length > 0 || p.web_hits_arr.length > 0);
        }
      } else {
        stats.tweet_filter_kept = 0;
      }
    }

    // ── Phase A.65: enrich `prepped` with RECENT DB same-symbol
    //    matches (last 1 hour) before copycat detection. Catches
    //    tokens that briefly fell out of trending between scans but
    //    still have fresh-enough on-chain data. We deliberately do NOT
    //    pull older records — a 5-hour-old last_price would be misleading
    //    in a card titled "live cross-chain copycats".
    {
      const symbolsInScope = new Set<string>(
        prepped
          .map((p) => String(p.source.symbol ?? "").toLowerCase())
          .filter(Boolean),
      );
      if (symbolsInScope.size > 0) {
        try {
          const { rows: histRows } = await db.query(
            `SELECT chain, address, symbol, last_price, last_market_cap, last_liquidity, last_analyzed_at
               FROM token_analyses
              WHERE LOWER(symbol) = ANY($1::text[])
                AND last_analyzed_at > NOW() - INTERVAL '1 hour'`,
            [Array.from(symbolsInScope)],
          );
          const peppedKeys = new Set(prepped.map((p) => `${p.source.chain}:${p.source.address}`));
          let added = 0;
          for (const r of histRows as any[]) {
            const key = `${r.chain}:${r.address}`;
            if (peppedKeys.has(key)) continue;        // already in current scan
            // Synthesize a minimal source row so detectCrossChainCopycats
            // can group it. We have no fresh chg/smart data — fields
            // default to 0 / null. Detection only needs symbol + chain
            // + address; member badges show last-seen DB price.
            const synth: any = {
              chain: r.chain,
              address: r.address,
              symbol: r.symbol,
              name: null,
              price: Number(r.last_price ?? 0),
              market_cap: Number(r.last_market_cap ?? 0),
              liquidity: Number(r.last_liquidity ?? 0),
              chg1h: 0, chg5m: 0, chg24h: null,
              smart_degen_count: 0,
              renowned_count: 0,
              rug_ratio: 0,
              is_honeypot: 0,
              is_wash_trading: false,
              dev_team_hold_rate: 0,
              bundler_rate: 0,
              age_h: null,
              is_db_historic: true,
              last_analyzed_at: r.last_analyzed_at,
            };
            // Push as a fake PreparedCandidate (just `source` is needed by
            // detectCrossChainCopycats, the other fields aren't read).
            prepped.push({
              source: synth,
              prior: undefined,
              curScore: 0,
              delta: { delta: 0, pct_delta: 0, continuing_up: false, is_spiking: false },
              newHistory: [],
              twitter_hits_raw: [],
              web_hits_arr: [],
              freshTweets: [],
              shouldAnalyze: false,
            });
            added++;
          }
          if (added > 0) {
            console.log(`[scan:meme] copycat history backfill: +${added} DB-only same-symbol rows for cross-chain grouping`);
          }
        } catch (e) {
          console.error("[scan:meme] copycat history query failed:", e);
        }
      }
    }

    // ── Phase A.7: cross-chain copycat detection ──
    //
    // Group all candidates by normalized name+symbol. Any group that
    // spans ≥ 2 chains AND has ≥ 1 smart-money buy AND isn't all
    // honeypot/rug is surfaced as a copycat signal. We then force the
    // analyzer to run on those members (they often have minimal
    // discussion individually but the cross-chain pattern IS the
    // signal — user wants the full 三问 on them).
    const copycatGroups = detectCrossChainCopycats(prepped.map((p) => p.source));
    const copycatKeys = new Set<string>();
    for (const g of copycatGroups) {
      for (const m of g.members) copycatKeys.add(`${m.chain}:${m.address}`);
    }
    if (copycatKeys.size > 0) {
      for (const p of prepped) {
        const key = `${p.source.chain}:${p.source.address}`;
        if (!copycatKeys.has(key)) continue;
        // Gate copycat members through IF there's any material to feed
        // the analyzer. If no tweets and no web hits, analyzer would
        // have nothing to say — don't force an empty call.
        if (p.freshTweets.length > 0 || p.web_hits_arr.length > 0) {
          p.shouldAnalyze = true;
        }
      }
      console.log(`[scan:meme] copycats: ${copycatGroups.length} groups spanning ${copycatKeys.size} tokens`);
    }

    // ── Phase B: ONE batched LLM call for all candidates needing analysis ──
    //    N candidates → 1 request. No more GLM per-minute rate limit blowouts.
    const toAnalyze = prepped.filter((p) => p.shouldAnalyze).slice(0, MAX_ANALYZER_BATCH_SIZE);
    let answersMap = new Map<string, ThreeAnswers>();
    if (toAnalyze.length > 0) {
      stats.analyzer_calls = 1;          // one call, regardless of N candidates
      const batchItems: BatchItem[] = toAnalyze.map((p) => ({
        key: `${p.source.chain}:${p.source.address}`,
        facts: {
          chain: p.source.chain,
          symbol: p.source.symbol ?? undefined,
          name: p.source.name ?? undefined,
          address: p.source.address,
          price: p.source.price,
          chg1h: p.source.chg1h,
          chg24h: p.source.chg24h,
          market_cap: p.source.market_cap,
          twitter_handle: p.source.twitter ?? null,
          website: p.source.website ?? null,
          description: p.source.description ?? null,
          liquidity: p.source.liquidity,
          age_h: p.source.age_h,
        },
        disc: {
          tweet_snippets: p.freshTweets.slice(0, 5).map((t) => ({
            author: t.screen_name,
            followers: t.followers,
            text: t.raw_text,
            created_at: t.created_at_ms ? new Date(t.created_at_ms).toISOString() : undefined,
          })),
          web_snippets: p.web_hits_arr.slice(0, 4).map((h) => ({
            title: h.title, snippet: h.snippet, date: h.date,
          })),
        },
        prior: p.prior ? {
          what_is: p.prior.narrative_what_is,
          narrative_direction: p.prior.narrative_direction,
          recent_reason: p.prior.recent_reason,
          last_analyzed_at: p.prior.last_analyzed_at?.toISOString() ?? null,
        } : undefined,
      }));
      answersMap = await analyzeBatch(batchItems);
      stats.analyzer_success = answersMap.size;
    }

    // ── Phase C: finalize (compute heat/discussion + upsert db) ──
    // CRITICAL: skip DB-historic backfill rows. Those synth rows have
    // all-zero source data (price/mcap/smart) and exist only so cross-
    // chain copycat detection can group same-symbol tokens that fell
    // out of trending. Running them through finalizeCandidate would
    // overwrite the real DB row with zeros (we just had this bug
    // wipe 6AVAUKa9 SCAM's $14M mcap → $0).
    const results: CandidateOutput[] = [];
    for (const p of prepped) {
      if (p.source?.is_db_historic) continue;
      const key = `${p.source.chain}:${p.source.address}`;
      const answers = answersMap.get(key) ?? null;
      const out = await finalizeCandidate(p, answers);
      if (out?.passed) stats.newly_passed++;
      if (out && out.fresh_tweets === 0 && out.web_hits === 0) stats.zero_discussion_strikes++;
      results.push(out);
    }

    // 5. User rule (refined): only push three explicit categories +
    //    🔥 quality tier. Type-gate is alert_category in
    //    {zombie | new | continuing}; quality gate is alert_tier=🔥.
    //    Anything outside is recorded in brain markdown but muted.
    const reportable = results
      .filter((r) => !r.passed)
      .filter((r) => r.alert_category !== "")
      .sort((a, b) => b.heat_score - a.heat_score)
      .slice(0, TOP_N_REPORT);

    // 6. Aggregate narratives onto each copycat group. Prefer THE
    //    BEST analyzer answer across members — i.e. the one that does
    //    NOT contain a stale-marker / "no-catalyst" disclaimer.
    //    Falling back to first-non-empty would let one bad answer
    //    block out a sibling's good answer.
    const NO_CATALYST_RX = /近\s*7\s*天.*未发现|未发现新催化|未发现明确催化|材料不足|需继续观察/;
    const isUsableNarrative = (s: string | null | undefined): boolean => {
      if (!s) return false;
      if (NO_CATALYST_RX.test(s)) return false;
      if (containsStaleMarker(s)) return false;
      return s.length >= 10;
    };
    const pickBestField = (
      candidates: Array<string | null | undefined>,
      validate: (s: string) => boolean,
    ): string | null => {
      // First pass: best-quality (passes validate)
      for (const c of candidates) if (c && validate(c)) return c;
      // Fallback: any non-empty (so we still record SOMETHING in brain)
      for (const c of candidates) if (c) return c;
      return null;
    };
    for (const g of copycatGroups) {
      const whats: Array<string | null | undefined> = [];
      const dirs: Array<string | null | undefined> = [];
      const reasons: Array<string | null | undefined> = [];
      for (const m of g.members) {
        const key = `${m.chain}:${m.address}`;
        const fresh = answersMap.get(key);
        if (fresh) {
          whats.push(fresh.what_is);
          dirs.push(fresh.narrative_direction);
          reasons.push(fresh.recent_reason);
        }
        const prep = prepped.find((p) => p.source.chain === m.chain && p.source.address === m.address);
        const prior = prep?.prior;
        if (prior) {
          whats.push(prior.narrative_what_is);
          dirs.push(prior.narrative_direction);
          reasons.push(prior.recent_reason);
        }
      }
      g.narrative_what_is = pickBestField(whats, isUsableNarrative);
      g.narrative_direction = pickBestField(dirs, isUsableNarrative);
      g.recent_reason = pickBestField(reasons, isUsableNarrative);
    }

    // 7. Suppress copycat groups whose recent_reason is a "no-catalyst"
    //    disclaimer or stale-marker. The user's rule: don't push to
    //    Telegram unless we have an actual catalyst story.
    const narrativeOk = copycatGroups.filter((g) => isUsableNarrative(g.recent_reason));
    if (narrativeOk.length < copycatGroups.length) {
      console.log(
        `[scan:meme] copycats: ${copycatGroups.length} groups detected, ` +
        `${narrativeOk.length} have usable narrative — others muted`,
      );
    }

    // 8. Cooldown: same group keeps trending scan after scan and the
    //    user gets 4-5 duplicate cards per hour. Mute re-pushes unless
    //    a new chain joined / smart-money grew / chg1h doubled / 6h
    //    elapsed since last push.
    const reportableCopycats = await applyCopycatCooldown(narrativeOk);

    return {
      ts: new Date().toISOString(),
      stats,
      candidates: reportable,
      copycats: reportableCopycats,
      all_processed_count: results.length,
    };
  },
});

export const memeScanTools = [memeScanTool];
