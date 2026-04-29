/**
 * Symbol-level snapshot store — per scan we persist a compact row per symbol
 * we touched. Next scan reads the "last snapshot" and feeds only the delta
 * to the main reasoning model instead of re-shipping every raw tool return.
 *
 * Design goals:
 *   - No per-field typing theatre; callers pass whichever fields they extracted.
 *   - Failure to save must not crash a scan (snapshot is a performance cache,
 *     not a correctness dependency). All errors are logged + swallowed.
 *   - Deltas are computed on the caller side from (prev, current) pairs so the
 *     same helper works for meme and futures with different schemas.
 */
import { db } from "../db/client.js";

export type Scope = "meme" | "futures";

export interface SnapshotFields {
  symbol: string;
  chain?: string | null;
  address?: string | null;
  price?: number | null;
  chg1h?: number | null;
  chg24h?: number | null;
  mcap?: number | null;
  liquidity?: number | null;
  oi_ratio?: number | null;
  funding?: number | null;
  square_en_count?: number | null;
  square_zh_count?: number | null;
  tw_legit_count?: number | null;
  ca_hits?: number | null;
  sentiment_direction?: "bull" | "bear" | "neutral" | "sparse" | null;
  narrative?: string | null;
  raw_digest?: Record<string, any> | null;
  extra?: Record<string, any> | null;
}

export interface SavedSnapshot extends SnapshotFields {
  id: number;
  scope: Scope;
  scan_id: string | null;
  ts: Date;
}

/** Save one snapshot. Never throws. */
export async function saveSnapshot(
  scope: Scope,
  scanId: string | null,
  f: SnapshotFields
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO symbol_snapshots
         (scope, scan_id, symbol, chain, address, price, chg1h, chg24h,
          mcap, liquidity, oi_ratio, funding,
          square_en_count, square_zh_count, tw_legit_count, ca_hits,
          sentiment_direction, narrative, raw_digest, extra)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [
        scope,
        scanId,
        f.symbol,
        f.chain ?? null,
        f.address ?? null,
        f.price ?? null,
        f.chg1h ?? null,
        f.chg24h ?? null,
        f.mcap ?? null,
        f.liquidity ?? null,
        f.oi_ratio ?? null,
        f.funding ?? null,
        f.square_en_count ?? null,
        f.square_zh_count ?? null,
        f.tw_legit_count ?? null,
        f.ca_hits ?? null,
        f.sentiment_direction ?? null,
        f.narrative ?? null,
        f.raw_digest ? JSON.stringify(f.raw_digest) : null,
        f.extra ? JSON.stringify(f.extra) : null,
      ]
    );
  } catch (e) {
    console.error(`[snapshot] save failed for ${scope}/${f.symbol}:`, e);
  }
}

/** Batch variant — one db round-trip per call. Never throws. */
export async function saveSnapshots(
  scope: Scope,
  scanId: string | null,
  items: SnapshotFields[]
): Promise<void> {
  if (items.length === 0) return;
  // Sequential is fine — items are typically < 30 per scan
  for (const f of items) await saveSnapshot(scope, scanId, f);
}

/** Most-recent snapshot for a single symbol. */
export async function loadLastSnapshot(
  scope: Scope,
  symbol: string,
  excludeScanId?: string
): Promise<SavedSnapshot | null> {
  try {
    const params: any[] = [scope, symbol];
    let where = "scope = $1 AND symbol = $2";
    if (excludeScanId) {
      params.push(excludeScanId);
      where += ` AND (scan_id IS NULL OR scan_id <> $${params.length})`;
    }
    const { rows } = await db.query(
      `SELECT * FROM symbol_snapshots WHERE ${where} ORDER BY ts DESC LIMIT 1`,
      params
    );
    return (rows[0] as SavedSnapshot) ?? null;
  } catch (e) {
    console.error(`[snapshot] load failed for ${scope}/${symbol}:`, e);
    return null;
  }
}

/** Batch load prev snapshots for several symbols in one query. */
export async function loadLastSnapshots(
  scope: Scope,
  symbols: string[],
  excludeScanId?: string
): Promise<Map<string, SavedSnapshot>> {
  const out = new Map<string, SavedSnapshot>();
  if (symbols.length === 0) return out;
  try {
    const params: any[] = [scope, symbols];
    let where = "scope = $1 AND symbol = ANY($2)";
    if (excludeScanId) {
      params.push(excludeScanId);
      where += ` AND (scan_id IS NULL OR scan_id <> $${params.length})`;
    }
    const { rows } = await db.query(
      `SELECT DISTINCT ON (symbol) *
         FROM symbol_snapshots
         WHERE ${where}
         ORDER BY symbol, ts DESC`,
      params
    );
    for (const r of rows as SavedSnapshot[]) out.set(r.symbol, r);
  } catch (e) {
    console.error(`[snapshot] batch load failed:`, e);
  }
  return out;
}

// ─── Delta computation ────────────────────────────────────────────

export interface Delta {
  symbol: string;
  age_minutes: number | null;
  changes: Record<string, { from: any; to: any; delta?: number; delta_pct?: number }>;
  is_new: boolean;
}

const DIFF_NUMERIC_FIELDS: (keyof SnapshotFields)[] = [
  "price", "chg1h", "chg24h", "mcap", "liquidity",
  "oi_ratio", "funding",
  "square_en_count", "square_zh_count", "tw_legit_count", "ca_hits",
];

const DIFF_STRING_FIELDS: (keyof SnapshotFields)[] = ["sentiment_direction"];

/** Compute a delta between the previous snapshot and the current extracted
 * fields. Only records fields that actually changed. */
export function computeDelta(
  prev: SavedSnapshot | null,
  current: SnapshotFields
): Delta {
  if (!prev) {
    return { symbol: current.symbol, age_minutes: null, changes: {}, is_new: true };
  }
  const ageMs = Date.now() - new Date(prev.ts).getTime();
  const age_minutes = Math.round(ageMs / 60_000);
  const changes: Delta["changes"] = {};

  for (const k of DIFF_NUMERIC_FIELDS) {
    const from = (prev as any)[k];
    const to = (current as any)[k];
    if (from == null && to == null) continue;
    if (from == null || to == null) { changes[k as string] = { from, to }; continue; }
    const a = Number(from);
    const b = Number(to);
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a === b) continue;
    const delta = b - a;
    const delta_pct = a !== 0 ? (delta / Math.abs(a)) * 100 : null;
    changes[k as string] = { from: a, to: b, delta, delta_pct: delta_pct ?? undefined };
  }

  for (const k of DIFF_STRING_FIELDS) {
    const from = (prev as any)[k];
    const to = (current as any)[k];
    if (from !== to) changes[k as string] = { from, to };
  }

  return { symbol: current.symbol, age_minutes, changes, is_new: false };
}

/** Compact human-readable delta (used in cheap-LLM prompts and brain md). */
export function formatDeltaLine(d: Delta): string {
  if (d.is_new) return `${d.symbol}: new (no prior snapshot)`;
  const parts: string[] = [];
  for (const [k, c] of Object.entries(d.changes)) {
    if (c.delta_pct != null && c.delta != null) {
      const sign = c.delta >= 0 ? "+" : "";
      parts.push(`${k} ${c.from} → ${c.to} (${sign}${c.delta_pct.toFixed(1)}%)`);
    } else {
      parts.push(`${k} ${c.from} → ${c.to}`);
    }
  }
  if (parts.length === 0) return `${d.symbol}: unchanged (${d.age_minutes}m ago)`;
  return `${d.symbol} (${d.age_minutes}m ago): ${parts.slice(0, 4).join(", ")}`;
}
