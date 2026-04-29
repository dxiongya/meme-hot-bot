/**
 * GeckoTerminal API client — used as a second-source for ETH meme
 * discovery because Ave's trending sorts by absolute TVL/volume and
 * misses small-liquidity tokens that are pumping hundreds of percent.
 *
 * GT sorts pools by h24 change / volume / new-deployed, which is
 * exactly the signal we want for meme pump detection.
 *
 * No API key required. Free tier is 30 req/min — we use ≤ 5 per scan.
 *
 * Proxy note: the SSH-tunneled HTTPS_PROXY (VPS 69.17.3.225) has been
 * observed to drop GT requests silently. We force-bypass the global
 * undici dispatcher for GT by supplying a fresh no-proxy Agent.
 */
import { Agent } from "undici";

const DIRECT_DISPATCHER = new Agent();   // no proxy — egress via whatever route the OS picks
const BASE = "https://api.geckoterminal.com/api/v2";

// Global GT throttle — free tier is 30 req/min (≈2.0s average).
// One scan fans out 4 chains, so a per-call ≥2.1s global gap keeps
// everyone under the ceiling even when chains run back-to-back.
let lastGtCallMs = 0;
const GT_MIN_INTERVAL_MS = 2_100;

export interface GtPool {
  id: string;
  attributes: {
    name?: string;
    address?: string;
    pool_created_at?: string;
    base_token_price_usd?: string;
    fdv_usd?: string | null;
    market_cap_usd?: string | null;
    reserve_in_usd?: string;
    volume_usd?: { h24?: string; h1?: string; h6?: string; m5?: string; m15?: string; m30?: string };
    price_change_percentage?: { h24?: string; h1?: string; h6?: string; m5?: string; m15?: string; m30?: string };
    transactions?: any;
  };
  relationships: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
}

async function gtFetch(path: string): Promise<GtPool[]> {
  // Global throttle — ensure ≥ 2.1s between any two GT calls across
  // the entire process (all chains, all endpoints). Without this,
  // 4-chain fan-out blows through the 30-req/min free-tier limit in
  // under 10s and every chain after the first hits 429.
  const elapsed = Date.now() - lastGtCallMs;
  if (elapsed < GT_MIN_INTERVAL_MS) {
    await new Promise<void>((r) => setTimeout(r, GT_MIN_INTERVAL_MS - elapsed));
  }
  lastGtCallMs = Date.now();

  try {
    const res = await fetch(`${BASE}${path}`, {
      // @ts-expect-error undici dispatcher option is correct but not in native fetch typing
      dispatcher: DIRECT_DISPATCHER,
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) {
      console.error(`[gt] HTTP ${res.status} for ${path}`);
      return [];
    }
    const body: any = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  } catch (e: any) {
    console.error(`[gt] fetch ${path}:`, e?.message ?? e);
    return [];
  }
}

// gmgn uses short codes (sol/eth/bsc/base); GT uses full slugs. Map.
const GT_NETWORK_BY_CHAIN: Record<string, string> = {
  sol: "solana",
  eth: "eth",
  base: "base",
  bsc: "bsc",
};

/**
 * Fetch pools on a given chain, sorted to surface pump candidates.
 * Returns the union of three sort orders, deduplicated by base token:
 *   - trending (GT's own composite score — catches pump winners)
 *   - h24_volume (established big movers)
 *   - new (fresh pools, early-stage discovery)
 *
 * Why this exists: gmgn-cli's `trending --order-by volume` misses
 * small-TVL tokens pumping thousands of percent on day-old pools,
 * because volume-ranked lists are dominated by established TVL giants.
 * GT's trending ranking is pump-biased — exactly what we need.
 */
export async function fetchGtPools(
  chain: keyof typeof GT_NETWORK_BY_CHAIN,
  pagesPerSort = 1,      // default 1 page × 1 endpoint = 1 GT call per chain
): Promise<GtPool[]> {
  const net = GT_NETWORK_BY_CHAIN[chain];
  if (!net) return [];
  // trending_pools = GT's pump-biased composite (catches established
  //   moving meme — BOAR, ASTEROID).
  // new_pools     = freshly-deployed pairs (catches pump.fun rockets
  //   that haven't yet bubbled into trending — LUCA-style).
  // Two endpoints × 4 chains × 1 page = 8 GT calls per scan, well under
  // the 30/min free-tier limit thanks to the global throttle.
  const seeds = [
    `/networks/${net}/trending_pools`,
    `/networks/${net}/new_pools`,
  ];
  const allPools: GtPool[] = [];
  for (const path of seeds) {
    for (let page = 1; page <= pagesPerSort; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const pools = await gtFetch(`${path}${sep}page=${page}`);
      allPools.push(...pools);
    }
  }

  // Dedup by base_token address, keeping the first occurrence (trending
  // pool wins over volume-sort wins over new-pool).
  const seen = new Set<string>();
  const unique: GtPool[] = [];
  for (const p of allPools) {
    const baseId = String(p.relationships?.base_token?.data?.id ?? "");
    // id is "eth_0xADDR"; strip the prefix to get pure address
    const addr = baseId.split("_").pop()?.toLowerCase();
    if (!addr || addr.length < 20) continue;
    if (seen.has(addr)) continue;
    seen.add(addr);
    unique.push(p);
  }
  console.log(`[gt] ${chain}: fetched ${allPools.length} pools across ${seeds.length} sorts → ${unique.length} unique tokens`);
  return unique;
}

// Back-compat alias for existing ETH callers.
export const fetchGtEthPools = (pagesPerSort = 2) => fetchGtPools("eth", pagesPerSort);

/**
 * Normalize a GT pool into the slim trending-item shape that scan.ts
 * expects (matches `slimTrendingItem()` return type from gmgn.ts).
 *
 * Fields GT doesn't surface — holders, rug_ratio, is_honeypot,
 * dev/bundler rates — are left `null` so hardFilter can distinguish
 * "unknown" from "known-bad" and treat unknown as acceptable.
 */
export function gtPoolToSlim(p: GtPool, chain: keyof typeof GT_NETWORK_BY_CHAIN = "eth") {
  const a = p.attributes;
  const baseId = String(p.relationships?.base_token?.data?.id ?? "");
  // Solana addresses are case-sensitive base58 (NOT hex) — don't lowercase!
  // EVM addresses are hex and lowercase-canonical.
  const rawAddr = baseId.split("_").pop() ?? "";
  const address = chain === "sol" ? rawAddr : rawAddr.toLowerCase();
  const ageH = a.pool_created_at
    ? (Date.now() - Date.parse(a.pool_created_at)) / 3_600_000
    : null;
  // GT names the pool "SYMBOL / QUOTE 1%" — split out base symbol
  const symbol = String(a.name ?? "?").split("/")[0]?.trim() ?? "?";
  return {
    address,
    symbol,
    name: undefined,
    chain,
    price: Number(a.base_token_price_usd ?? 0),
    market_cap: Number(a.market_cap_usd ?? a.fdv_usd ?? 0),
    liquidity: Number(a.reserve_in_usd ?? 0),
    volume: Number(a.volume_usd?.h24 ?? 0),
    chg1h: Number(a.price_change_percentage?.h1 ?? 0),
    chg5m: Number(a.price_change_percentage?.m5 ?? 0) || null,
    chg24h: Number(a.price_change_percentage?.h24 ?? 0),
    holders: null,                   // unknown — hardFilter permits when null
    smart_degen_count: 0,
    renowned_count: 0,
    rug_ratio: null,                 // unknown → treat as safe
    is_wash_trading: false,
    is_honeypot: null,
    age_h: ageH,
    top_10_holder_rate: null,
    dev_team_hold_rate: null,
    bundler_rate: null,
    creator_token_status: null,
    platform: p.relationships?.dex?.data?.id ?? null,
    twitter: null,
    website: null,
    description: null,
    _source: "geckoterminal" as const,
  };
}
