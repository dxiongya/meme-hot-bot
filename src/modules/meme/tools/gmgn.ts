import { Type } from "@sinclair/typebox";
import { defineJsonTool } from "../../../lib/tool-helpers.js";
import { execJson } from "../../../lib/exec.js";

const ChainEnum = Type.Union(
  [Type.Literal("sol"), Type.Literal("base"), Type.Literal("bsc")],
  { description: "gmgn-supported chain" }
);

/**
 * gmgn rank item has 50+ fields — too heavy for context. Trim to essentials.
 */
export function slimTrendingItem(r: Record<string, any>) {
  const age_h = r.creation_timestamp
    ? (Date.now() / 1000 - Number(r.creation_timestamp)) / 3600
    : null;
  return {
    address: r.address,
    symbol: r.symbol,
    chain: r.chain,
    price: r.price,
    market_cap: r.market_cap,
    liquidity: r.liquidity,
    volume: r.volume,
    chg1h: r.price_change_percent1h,
    chg5m: r.price_change_percent5m,
    holders: r.holder_count,
    smart_degen_count: r.smart_degen_count,
    renowned_count: r.renowned_count,
    rug_ratio: r.rug_ratio,
    is_wash_trading: r.is_wash_trading,
    is_honeypot: r.is_honeypot,
    age_h,                          // hours since creation
    top_10_holder_rate: r.top_10_holder_rate,
    dev_team_hold_rate: r.dev_team_hold_rate,
    bundler_rate: r.bundler_rate,
    creator_token_status: r.creator_token_status,
    platform: r.launchpad_platform,
    twitter: r.twitter_username,
    website: r.website,
  };
}

/**
 * Code-level hard filter applied AFTER slim. Prevents obvious garbage from
 * even reaching the agent's context. Anything here is unrecoverable trash.
 */
export function hardFilter(r: ReturnType<typeof slimTrendingItem> | Record<string, any>): boolean {
  // All these checks now distinguish three states:
  //   value = null/undefined  → UNKNOWN (source doesn't surface it) → let pass
  //   value = number/bool     → KNOWN → apply threshold
  // This matters because GeckoTerminal-sourced tokens have many null
  // fields (it doesn't report holder counts, rug score, etc.), but they
  // are legitimately trending meme candidates — we shouldn't drop them.
  const isKnownNum = (x: any) => x !== null && x !== undefined && !Number.isNaN(Number(x));

  if (isKnownNum(r.rug_ratio) && Number(r.rug_ratio) >= 0.3) return false;
  if (r.is_wash_trading === true) return false;
  if (isKnownNum(r.is_honeypot) && Number(r.is_honeypot) === 1) return false;
  if (Number(r.liquidity ?? 0) < 30_000) return false;                      // liquidity is always reported by both sources
  if (isKnownNum(r.holders) && Number(r.holders) < 300) return false;       // known-low distribution only
  if (isKnownNum(r.dev_team_hold_rate) && Number(r.dev_team_hold_rate) > 0.15) return false;
  if (isKnownNum(r.bundler_rate) && Number(r.bundler_rate) > 0.40) return false;
  // REMOVED (per user): top_10_holder_rate > 0.35 and age_h < 0.5
  // Meme often has whale-dominated early distribution AND brand-new launches
  // are exactly what we want to catch — filtering them out loses real alpha.
  return true;
}

function slimBuyItem(r: Record<string, any>) {
  return {
    address: r.base_address,
    symbol: r.base_token?.symbol,
    side: r.side,
    amount_usd: r.amount_usd,
    price_usd: r.price_usd,
    is_open_or_close: r.is_open_or_close,
    ts: r.timestamp,
    maker: r.maker,
    maker_tags: r.maker_info?.tags,
    maker_twitter: r.maker_info?.twitter_username,
  };
}

export const gmgnTrendingTool = defineJsonTool({
  name: "gmgn_trending",
  label: "gmgn trending",
  description:
    "Pull trending tokens (1h window) on a gmgn chain (sol/base/bsc) sorted by volume. Returns symbol, address, price, mcap, liq, chg1h, chg5m, holders, smart_degen_count, renowned_count, rug_ratio, is_wash_trading, is_honeypot, created_ts, open_ts, platform, twitter, website.",
  parameters: Type.Object({
    chain: ChainEnum,
    limit: Type.Number({ minimum: 1, maximum: 100, default: 30 }),
    interval: Type.Optional(
      Type.Union([
        Type.Literal("1m"),
        Type.Literal("5m"),
        Type.Literal("1h"),
        Type.Literal("6h"),
        Type.Literal("24h"),
      ])
    ),
  }),
  run: async ({ chain, limit, interval }) => {
    const args = [
      "market", "trending",
      "--chain", chain,
      "--interval", interval ?? "1h",
      "--limit", String(limit),
      "--order-by", "volume",
      "--raw",
    ];
    if (chain === "sol") {
      args.push("--filter", "renounced", "--filter", "frozen", "--filter", "not_wash_trading");
    } else {
      args.push("--filter", "not_honeypot", "--filter", "verified", "--filter", "renounced");
    }
    const data = await execJson<{ data: { rank: Record<string, any>[] } }>("gmgn-cli", args, { timeoutMs: 60_000 });
    const slim = data.data.rank.map(slimTrendingItem);
    const survived = slim.filter(hardFilter);
    return { chain, total_pulled: slim.length, after_hard_filter: survived.length, tokens: survived };
  },
});

export const gmgnSmartMoneyTool = defineJsonTool({
  name: "gmgn_smartmoney_buys",
  label: "gmgn smart money buys",
  description:
    "Recent BUY trades from gmgn-tagged smart-money wallets on a chain. Use to detect cluster signals (multiple SM wallets buying same token). Returns address, symbol, side, amount_usd, price_usd, ts, maker, maker_tags.",
  parameters: Type.Object({
    chain: ChainEnum,
    limit: Type.Number({ minimum: 1, maximum: 200, default: 80 }),
  }),
  run: async ({ chain, limit }) => {
    const data = await execJson<{ list: Record<string, any>[] }>(
      "gmgn-cli",
      ["track", "smartmoney", "--chain", chain, "--side", "buy", "--limit", String(limit), "--raw"],
      { timeoutMs: 60_000 }
    );
    return data.list.map(slimBuyItem);
  },
});

export const gmgnKolBuysTool = defineJsonTool({
  name: "gmgn_kol_buys",
  label: "gmgn KOL buys",
  description:
    "Recent BUY trades from gmgn-tagged KOL/influencer wallets on a chain. Returns address, symbol, side, amount_usd, price_usd, ts, maker, maker_tags, maker_twitter.",
  parameters: Type.Object({
    chain: ChainEnum,
    limit: Type.Number({ minimum: 1, maximum: 200, default: 80 }),
  }),
  run: async ({ chain, limit }) => {
    const data = await execJson<{ list: Record<string, any>[] }>(
      "gmgn-cli",
      ["track", "kol", "--chain", chain, "--side", "buy", "--limit", String(limit), "--raw"],
      { timeoutMs: 60_000 }
    );
    return data.list.map(slimBuyItem);
  },
});

/**
 * K-line tool for dormant→pump detection. Returns close prices over a window
 * so the agent can compute volatility + breakout.
 */
export const gmgnKlineTool = defineJsonTool({
  name: "gmgn_kline",
  label: "gmgn kline",
  description:
    "Pull OHLCV candles for a token. Use to detect dormant-then-pump pattern (low stddev in prior window + sudden breakout). Returns array of {ts, open, close, high, low, volume}.",
  parameters: Type.Object({
    chain: ChainEnum,
    address: Type.String(),
    resolution: Type.Union(
      [Type.Literal("5m"), Type.Literal("15m"), Type.Literal("1h"), Type.Literal("4h"), Type.Literal("1d")],
      { default: "1h" }
    ),
    hours_back: Type.Number({ minimum: 1, maximum: 168, default: 48 }),
  }),
  run: async ({ chain, address, resolution, hours_back }) => {
    const to = Math.floor(Date.now() / 1000);
    const from = to - hours_back * 3600;
    const data = await execJson<{ list: Array<{ time: number; open: string; close: string; high: string; low: string; volume: string }> }>(
      "gmgn-cli",
      [
        "market", "kline",
        "--chain", chain,
        "--address", address,
        "--resolution", resolution,
        "--from", String(from),
        "--to", String(to),
        "--raw",
      ],
      { timeoutMs: 30_000 }
    );
    return data.list.map((c) => ({
      ts: c.time,
      open: Number(c.open),
      close: Number(c.close),
      high: Number(c.high),
      low: Number(c.low),
      volume: Number(c.volume),
    }));
  },
});

export const gmgnTools = [gmgnTrendingTool, gmgnSmartMoneyTool, gmgnKolBuysTool, gmgnKlineTool];
