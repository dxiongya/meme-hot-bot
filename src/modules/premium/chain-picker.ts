/**
 * Cross-chain best-of-breed picker for the premium module.
 *
 * Same meme often deploys on sol/eth/bsc/base within hours. Naive
 * push: blast all four members → user gets 4 cards for the same idea.
 * Premium push: pick THE chain that's currently winning the cluster
 * and surface only that one.
 *
 *   1. Group passed candidates by normalized symbol (PEPE/$PEPE/Pepe.fun
 *      all collapse to "pepe").
 *   2. Within a cluster, pick best-of-breed PER chain (highest score).
 *   3. Across the per-chain winners, pick the SINGLE strongest as the
 *      cluster's leader.
 *
 * Score = smart_degen_count*2 + renowned_count*3 + chg1h_clamped + mcap_health,
 * where mcap_health rewards the [$500K, $5M] sweet spot and penalizes
 * extremes. Each scan re-evaluates so the leader can shift between
 * chains as flows rotate.
 */
import type { PremiumCandidate } from "./filter.js";

function normalizeSymbol(symbol: string | null, name?: string | null): string {
  const combined = `${symbol ?? ""}${name ?? ""}`.toLowerCase();
  return combined.replace(/[^\p{L}\p{N}]/gu, "").trim();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function mcapHealth(mcap: number): number {
  // 0 → 10 score. Sweet spot: $500K-$5M (early breakout, room to run).
  // Sub-$200K = sketchy, $30M+ = late.
  if (mcap < 200_000) return 1;
  if (mcap < 500_000) return 5;
  if (mcap <= 5_000_000) return 10;
  if (mcap <= 15_000_000) return 6;
  return 2;
}

export function scoreCandidate(c: PremiumCandidate): number {
  const s = c.last_safety || {};
  const smart = Number(s.smart_degen_count ?? 0);
  const kol = Number(s.renowned_count ?? 0);
  const chg1h = Number(s.chg1h ?? 0);
  // Cap chg1h influence at 200% — anything past that is noise / about
  // to crash, not signal.
  const chgScore = clamp(chg1h, -50, 200) * 0.05;
  return smart * 2 + kol * 3 + chgScore + mcapHealth(c.last_market_cap);
}

export interface ClusterPick {
  cluster_key: string;
  leader: PremiumCandidate;
  chains_in_cluster: string[];
  members_per_chain: Record<string, PremiumCandidate>;   // best of each chain
  chosen_reason: string;
  cluster_size: number;
}

export interface PickerResult {
  /** One pick per cluster. Standalone tokens (no copycats) → cluster_size=1. */
  picks: ClusterPick[];
  /** Tokens that lost the cluster contest, recorded for transparency. */
  runners_up: Array<{ pick: ClusterPick; loser: PremiumCandidate; chain: string }>;
}

export function pickBestPerCluster(passed: PremiumCandidate[]): PickerResult {
  // Step 1: cluster by normalized symbol
  const clusters = new Map<string, PremiumCandidate[]>();
  for (const c of passed) {
    const key = normalizeSymbol(c.symbol);
    if (!key || key.length < 2) continue;     // pathological — skip
    const arr = clusters.get(key) ?? [];
    arr.push(c);
    clusters.set(key, arr);
  }

  const picks: ClusterPick[] = [];
  const runners_up: PickerResult["runners_up"] = [];

  for (const [clusterKey, members] of clusters) {
    // Step 2: best of each chain
    const perChain = new Map<string, PremiumCandidate>();
    const allMembersByChain = new Map<string, PremiumCandidate[]>();
    for (const m of members) {
      const chain = m.chain;
      const cur = perChain.get(chain);
      if (!cur || scoreCandidate(m) > scoreCandidate(cur)) perChain.set(chain, m);
      const list = allMembersByChain.get(chain) ?? [];
      list.push(m);
      allMembersByChain.set(chain, list);
    }

    // Step 3: pick the SINGLE leader across chains
    const chainWinners = Array.from(perChain.values());
    chainWinners.sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
    const leader = chainWinners[0];
    const second = chainWinners[1];

    const reasonParts: string[] = [];
    const lScore = scoreCandidate(leader);
    reasonParts.push(`score=${lScore.toFixed(1)}`);
    const ls = leader.last_safety || {};
    reasonParts.push(`smart=${ls.smart_degen_count ?? 0}+kol=${ls.renowned_count ?? 0}`);
    reasonParts.push(`mcap=$${Math.round(leader.last_market_cap)}`);
    reasonParts.push(`1h=${Number(ls.chg1h ?? 0).toFixed(1)}%`);
    if (second) {
      const margin = lScore - scoreCandidate(second);
      reasonParts.push(`beat_${second.chain}_by:${margin.toFixed(1)}`);
    }

    const pick: ClusterPick = {
      cluster_key: clusterKey,
      leader,
      chains_in_cluster: Array.from(perChain.keys()),
      members_per_chain: Object.fromEntries(perChain),
      chosen_reason: reasonParts.join(" · "),
      cluster_size: members.length,
    };
    picks.push(pick);

    // Track losers for transparency / future learning
    for (const c of chainWinners) {
      if (c !== leader) runners_up.push({ pick, loser: c, chain: c.chain });
    }
    // Also track within-chain losers (e.g. two PEPE on sol — only one survives)
    for (const [chain, list] of allMembersByChain) {
      const winner = perChain.get(chain);
      for (const m of list) {
        if (m !== winner) runners_up.push({ pick, loser: m, chain });
      }
    }
  }

  // Sort picks by leader score (best first)
  picks.sort((a, b) => scoreCandidate(b.leader) - scoreCandidate(a.leader));
  return { picks, runners_up };
}
