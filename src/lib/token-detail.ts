/**
 * Token deep-dive fetcher. Given a contract address, pull everything a
 * user would want to know before aping in:
 *   - main pool + all pools + total liquidity
 *   - recently-created pools (last 48h) — buyer-trap signal
 *   - creator (EVM chains via blockscout)
 *   - honeypot / mint-method / rug signals (best-effort by chain)
 *   - socials
 *
 * Sources (no API keys required):
 *   - Dexscreener /latest/dex/tokens/{CA}  — cross-chain pair data
 *   - Blockscout eth.blockscout.com         — ETH creator
 *   - Blockscout base.blockscout.com        — BASE creator
 *   - Dexscreener gives chainId so we route the explorer call correctly.
 *
 * Used by:
 *   - Telegram inbound bot (user pastes CA → bot replies with detail)
 *   - Future: enrich scan output per candidate
 */
import { Agent } from "undici";

// Dexscreener / blockscout both block the SSH-tunneled HTTPS_PROXY
// sporadically; use a direct no-proxy dispatcher for these calls.
const DIRECT = new Agent();

async function directFetch(url: string, timeoutMs = 8_000): Promise<any | null> {
  try {
    const res = await fetch(url, {
      // @ts-expect-error undici dispatcher option not in native fetch typing
      dispatcher: DIRECT,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.error(`[detail] HTTP ${res.status} ${url.slice(0, 120)}`);
      return null;
    }
    return await res.json();
  } catch (e: any) {
    console.error(`[detail] fetch ${url.slice(0, 80)}: ${e?.message ?? e}`);
    return null;
  }
}

export interface PoolInfo {
  dex: string;
  pairAddress: string;
  quoteSymbol: string;
  liquidityUsd: number;
  createdAt: string | null;
  priceUsd: number | null;
  chg24h: number | null;
  labels: string[];          // e.g. ["v3"], ["v4"]
}

export interface TokenDetail {
  chain: string;                    // dexscreener chainId: ethereum, bsc, base, solana, etc.
  address: string;
  symbol: string;
  name?: string;
  pools: PoolInfo[];
  mainPool: PoolInfo | null;        // highest-liquidity pool
  totalLiquidityUsd: number;
  recentlyCreatedPools: PoolInfo[]; // pools created in last 48h — liquidity-bait signal
  fdv?: number | null;
  mcap?: number | null;
  // EVM-only, via blockscout
  creator?: string | null;
  creatorTxHash?: string | null;
  contractCreatedAt?: string | null;  // ISO date
  ageDays?: number | null;
  // Socials (from dexscreener info)
  twitter?: string | null;
  website?: string | null;
  community?: string | null;
  // Risk signals we can compute locally
  signals: string[];                  // plain-text bullets
}

// ── Blockscout endpoints per chain ───────────────────────────
const BLOCKSCOUT_BY_CHAIN: Record<string, string> = {
  ethereum: "https://eth.blockscout.com",
  base: "https://base.blockscout.com",
  // bsc / solana don't have a blockscout instance accessible without keys
};

async function fetchCreator(chain: string, ca: string): Promise<{
  creator?: string;
  txHash?: string;
  createdAt?: string;
  ageDays?: number;
}> {
  const base = BLOCKSCOUT_BY_CHAIN[chain];
  if (!base) return {};
  const body: any = await directFetch(`${base}/api?module=contract&action=getcontractcreation&contractaddresses=${ca}`);
  const row = body?.result?.[0];
  if (!row?.contractCreator) return {};
  const ts = row.timestamp ? Number(row.timestamp) * 1000 : null;
  const createdAt = ts ? new Date(ts).toISOString() : undefined;
  const ageDays = ts ? (Date.now() - ts) / 86_400_000 : undefined;
  return {
    creator: String(row.contractCreator).toLowerCase(),
    txHash: row.txHash,
    createdAt,
    ageDays,
  };
}

function buildSignals(d: Pick<TokenDetail, "chain" | "ageDays" | "pools" | "recentlyCreatedPools" | "mainPool" | "totalLiquidityUsd">): string[] {
  const out: string[] = [];
  if (d.totalLiquidityUsd < 20_000) out.push("⚠️ 总流动性极低（<$20K），随时可拉走");
  if (d.mainPool && d.mainPool.liquidityUsd < 50_000) out.push("⚠️ 主池流动性单薄（<$50K）");
  if (d.recentlyCreatedPools.length > 0) {
    out.push(`⚠️ 最近 48h 新增 ${d.recentlyCreatedPools.length} 个池，疑似布局承接盘`);
  }
  if (d.ageDays !== null && d.ageDays !== undefined) {
    if (d.ageDays > 180 && d.pools.some((p) => p.createdAt && Date.now() - Date.parse(p.createdAt) < 48 * 3600_000)) {
      out.push(`⚠️ 合约部署 ${Math.round(d.ageDays)} 天，是老僵尸币被突然激活`);
    }
    if (d.ageDays < 1) out.push(`🆕 新币（<24h）`);
  }
  if (d.pools.length >= 3) out.push(`ℹ️ ${d.pools.length} 个池并存`);
  return out;
}

export async function fetchTokenDetail(ca: string): Promise<TokenDetail | null> {
  const ds: any = await directFetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`);
  const pairs = Array.isArray(ds?.pairs) ? ds.pairs : [];
  if (pairs.length === 0) return null;

  // Derive chain from the first pair (they should all match for same CA)
  const chain = String(pairs[0].chainId ?? "").toLowerCase();
  const base = pairs[0].baseToken;

  const pools: PoolInfo[] = pairs.map((p: any) => ({
    dex: String(p.dexId ?? "?"),
    pairAddress: String(p.pairAddress ?? ""),
    quoteSymbol: String(p.quoteToken?.symbol ?? "?"),
    liquidityUsd: Number(p.liquidity?.usd ?? 0),
    createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).toISOString() : null,
    priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
    chg24h: p.priceChange?.h24 != null ? Number(p.priceChange.h24) : null,
    labels: Array.isArray(p.labels) ? p.labels.map(String) : [],
  })).sort((a: PoolInfo, b: PoolInfo) => b.liquidityUsd - a.liquidityUsd);

  const now = Date.now();
  const FRESH_WINDOW_MS = 48 * 3600_000;
  const recent = pools.filter((p) => p.createdAt && now - Date.parse(p.createdAt) < FRESH_WINDOW_MS);

  // Pick the first pair that has info (socials + fdv + mcap)
  const info = pairs.find((p: any) => p.info) ?? pairs[0];
  const socialsArr: any[] = info?.info?.socials ?? [];
  const websitesArr: any[] = info?.info?.websites ?? [];
  const twitterRec = socialsArr.find((s) => String(s.type).toLowerCase() === "twitter");
  // X community URL is stored as twitter=x.com/i/communities/... sometimes
  const twitter = twitterRec?.url ?? null;
  const community = twitter && /i\/communities\//.test(twitter) ? twitter : null;

  const creatorInfo: {
    creator?: string;
    txHash?: string;
    createdAt?: string;
    ageDays?: number;
  } = await fetchCreator(chain, ca).catch(() => ({}));

  const detail: TokenDetail = {
    chain,
    address: ca.toLowerCase(),
    symbol: String(base?.symbol ?? "?"),
    name: base?.name ?? undefined,
    pools,
    mainPool: pools[0] ?? null,
    totalLiquidityUsd: pools.reduce((s, p) => s + p.liquidityUsd, 0),
    recentlyCreatedPools: recent,
    fdv: info?.fdv != null ? Number(info.fdv) : null,
    mcap: info?.marketCap != null ? Number(info.marketCap) : null,
    creator: creatorInfo.creator ?? null,
    creatorTxHash: creatorInfo.txHash ?? null,
    contractCreatedAt: creatorInfo.createdAt ?? null,
    ageDays: creatorInfo.ageDays ?? null,
    twitter: community ? null : twitter,
    website: websitesArr[0]?.url ?? null,
    community,
    signals: [],
  };
  detail.signals = buildSignals(detail);
  return detail;
}

function fmtUsd(n: number | null | undefined): string {
  if (n == null || !isFinite(n)) return "?";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtAge(days: number | null | undefined): string {
  if (days == null || !isFinite(days)) return "?";
  if (days < 1) return `${Math.round(days * 24)}h`;
  if (days < 60) return `${Math.round(days)}d`;
  return `${(days / 30).toFixed(1)}mo`;
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render a TokenDetail into a Telegram-friendly HTML message.
 * Layout mirrors the Michael Jackson analysis: header, facts table,
 * pool breakdown, risk signals.
 */
export function renderTokenDetailForTelegram(d: TokenDetail): string {
  const lines: string[] = [];
  const sym = escapeHtml(d.symbol || "?");
  const name = d.name && d.name !== d.symbol ? ` <i>(${escapeHtml(d.name)})</i>` : "";
  lines.push(`🔎 <b>${sym}</b>${name} · <i>${escapeHtml(d.chain)}</i>`);
  lines.push(`CA <code>${escapeHtml(d.address)}</code> <i>(点击复制)</i>`);

  // Price/mcap row
  const priceRow: string[] = [];
  if (d.mainPool?.priceUsd != null) priceRow.push(`币价 $${d.mainPool.priceUsd.toPrecision(4)}`);
  if (d.mcap != null) priceRow.push(`市值 ${fmtUsd(d.mcap)}`);
  else if (d.fdv != null) priceRow.push(`FDV ${fmtUsd(d.fdv)}`);
  if (d.mainPool?.chg24h != null) priceRow.push(`24h ${d.mainPool.chg24h >= 0 ? "+" : ""}${d.mainPool.chg24h.toFixed(1)}%`);
  if (priceRow.length) lines.push(priceRow.join(" · "));

  lines.push("");

  // Creator + age
  if (d.creator) {
    lines.push(`👤 <b>创建者</b> <code>${escapeHtml(d.creator)}</code>`);
  }
  if (d.contractCreatedAt) {
    lines.push(`📅 部署于 ${d.contractCreatedAt.slice(0, 10)} · 合约年龄 ${fmtAge(d.ageDays)}`);
  } else if (d.chain !== "ethereum" && d.chain !== "base") {
    lines.push(`📅 部署信息不可得（${escapeHtml(d.chain)} 链暂未接入 blockscout）`);
  }

  lines.push("");

  // Pools
  lines.push(`💧 <b>池子</b>（${d.pools.length} 个，总流动性 ${fmtUsd(d.totalLiquidityUsd)}）`);
  for (const p of d.pools.slice(0, 4)) {
    const age = p.createdAt
      ? ` · ${fmtAge((Date.now() - Date.parse(p.createdAt)) / 86_400_000)}前建`
      : "";
    const label = p.labels.length ? ` [${p.labels.join(",")}]` : "";
    lines.push(`  • ${escapeHtml(p.dex)}${label} ${escapeHtml(p.quoteSymbol)}: ${fmtUsd(p.liquidityUsd)}${age}`);
  }
  if (d.pools.length > 4) lines.push(`  … 另 ${d.pools.length - 4} 个池`);

  lines.push("");

  // Signals
  if (d.signals.length > 0) {
    lines.push(`🚨 <b>风险/信号</b>`);
    for (const s of d.signals) lines.push(`  ${escapeHtml(s)}`);
    lines.push("");
  }

  // Socials
  const socials: string[] = [];
  if (d.twitter) socials.push(`🐦 <a href="${escapeHtml(d.twitter)}">Twitter</a>`);
  if (d.community) socials.push(`👥 <a href="${escapeHtml(d.community)}">X 社区</a>`);
  if (d.website) socials.push(`🌐 <a href="${escapeHtml(d.website)}">官网</a>`);
  if (socials.length) lines.push(socials.join(" · "));

  // Dexscreener link for deep dive
  if (d.mainPool?.pairAddress) {
    lines.push(`🔗 <a href="https://dexscreener.com/${d.chain}/${d.mainPool.pairAddress}">Dexscreener 主池</a>`);
  }

  return lines.join("\n");
}
