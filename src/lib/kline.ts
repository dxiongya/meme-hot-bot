/**
 * Fetch + render mini K-line charts for Telegram messages.
 * Uses gmgn-cli market kline. Output is pure text (Unicode block
 * sparkline + emoji candle row), so it inlines into HTML messages
 * without needing sendPhoto.
 */
import { execJson } from "./exec.js";

export interface KlineCandle {
  ts: number;       // ms
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
}

const RESOLUTIONS = ["1m", "5m", "15m", "1h", "4h", "1d"] as const;
type Resolution = (typeof RESOLUTIONS)[number];

const RES_SECONDS: Record<Resolution, number> = {
  "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

/**
 * Pull recent OHLCV candles. Returns up to `count` most-recent
 * candles ordered oldest-first (so the rightmost is "now").
 */
export async function fetchKline(
  chain: string,
  address: string,
  resolution: Resolution,
  count: number,
): Promise<KlineCandle[]> {
  const gmgnChain = chain === "ethereum" ? "eth" : chain === "solana" ? "sol" : chain;
  if (!["sol", "bsc", "base", "eth"].includes(gmgnChain)) return [];
  const to = Math.floor(Date.now() / 1000);
  const from = to - RES_SECONDS[resolution] * count;
  try {
    const data = await execJson<{ list: Array<any> }>(
      "gmgn-cli",
      [
        "market", "kline",
        "--chain", gmgnChain,
        "--address", address,
        "--resolution", resolution,
        "--from", String(from),
        "--to", String(to),
        "--raw",
      ],
      { timeoutMs: 25_000 },
    );
    const list = data?.list ?? [];
    return list.map((c: any) => ({
      ts: Number(c.time ?? 0),
      open: Number(c.open ?? 0),
      close: Number(c.close ?? 0),
      high: Number(c.high ?? 0),
      low: Number(c.low ?? 0),
      volume: Number(c.volume ?? 0),
    })).filter((c) => c.ts > 0).slice(-count);
  } catch (e: any) {
    console.error(`[kline] ${gmgnChain}/${address}: ${e?.message ?? e}`);
    return [];
  }
}

const SPARK_BLOCKS = "▁▂▃▄▅▆▇█";

function fmtPrice(p: number): string {
  if (!isFinite(p) || p === 0) return "?";
  if (p >= 1) return `$${p.toPrecision(4)}`;
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  if (p >= 0.0001) return `$${p.toFixed(6)}`;
  // very small — 4 sigfigs
  return `$${p.toPrecision(4)}`;
}

function fmtUsdShort(n: number): string {
  if (!isFinite(n)) return "?";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

/**
 * Render N candles as a compact 2-line block:
 *   Line 1: 📊 sparkline + headline % + window
 *   Line 2: open→close · 量
 *
 * Emoji-dot row was dropped because it duplicated the sparkline visually
 * and stretched cards to 4 lines apiece — user feedback.
 */
export function renderKlineSparkline(
  candles: KlineCandle[],
  resolution: Resolution,
  windowLabel: string,    // "4h" or "2h" — display only
): string {
  if (candles.length === 0) return "";
  void resolution;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const lo = Math.min(...lows);
  const hi = Math.max(...highs);
  const range = hi - lo || 1;

  // Sparkline of normalized close prices
  const spark = closes.map((c) => {
    const n = Math.max(0, Math.min(7, Math.round(((c - lo) / range) * 7)));
    return SPARK_BLOCKS[n];
  }).join("");

  const open = candles[0].open;
  const close = candles[candles.length - 1].close;
  const pct = open > 0 ? ((close - open) / open) * 100 : 0;
  const totalVol = candles.reduce((s, c) => s + c.volume, 0);
  const arrow = pct > 1 ? "📈" : pct < -1 ? "📉" : "→";
  const sign = pct >= 0 ? "+" : "";

  return [
    `📊 <code>${spark}</code> ${arrow} <b>${sign}${pct.toFixed(1)}%</b> · ${windowLabel}`,
    `${fmtPrice(open)} → <b>${fmtPrice(close)}</b> · 量 <b>${fmtUsdShort(totalVol)}</b>`,
  ].join("\n");
}

/**
 * Convenience: pull 16 × 15m candles (4h window) and render.
 */
export async function fetchAndRenderKline4h15m(
  chain: string,
  address: string,
): Promise<string> {
  const candles = await fetchKline(chain, address, "15m", 16);
  if (candles.length === 0) return "";
  return renderKlineSparkline(candles, "15m", "4h");
}
