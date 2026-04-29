import { db } from "../../db/client.js";

export interface SearchHit {
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
  excerpt: string;
  score: number;
}

/**
 * Full-text search across pages.
 * - `scope`: path prefix filter, e.g. "meme" or "futures" (restricts to that module)
 * - `type`:  optional exact type filter
 */
export async function searchBrain(query: string, opts?: {
  scope?: string;
  type?: string;
  limit?: number;
}): Promise<SearchHit[]> {
  const limit = opts?.limit ?? 10;
  const params: unknown[] = [query];
  let where = "fts @@ websearch_to_tsquery('simple', $1)";
  if (opts?.type) {
    params.push(opts.type);
    where += ` AND type = $${params.length}`;
  }
  if (opts?.scope) {
    params.push(`${opts.scope}/%`);
    where += ` AND path LIKE $${params.length}`;
  }
  params.push(limit);
  const sql = `
    SELECT path, type, frontmatter,
           ts_headline('simple', content,
             websearch_to_tsquery('simple', $1),
             'StartSel=«, StopSel=», MaxFragments=2, MinWords=8, MaxWords=20'
           ) AS excerpt,
           ts_rank(fts, websearch_to_tsquery('simple', $1)) AS score
    FROM pages
    WHERE ${where}
    ORDER BY score DESC
    LIMIT $${params.length}
  `;
  const r = await db.query(sql, params);
  return r.rows as SearchHit[];
}

export async function getEntityPage(params: {
  scope: string;
  kind: "token" | "symbol";
  id1: string;                 // chain (meme) or symbol (futures)
  id2?: string;                // address (meme only)
}) {
  const id2 = params.id2 ?? "";
  const path = params.kind === "token"
    ? `${params.scope}/tokens/${params.id1}/${id2}.md`
    : `${params.scope}/symbols/${params.id1}.md`;
  const r = await db.query(
    `SELECT path, type, frontmatter, content, updated_at FROM pages WHERE path = $1`,
    [path]
  );
  return r.rows[0] ?? null;
}

export async function listStarredPages(scope: string, limit = 50) {
  const r = await db.query(
    `SELECT path, frontmatter, updated_at
       FROM pages
      WHERE path LIKE $1
        AND COALESCE((frontmatter ->> 'appearance_count')::int, 0) > 1
        AND COALESCE((frontmatter ->> 'banned')::boolean, false) = false
      ORDER BY (frontmatter ->> 'appearance_count')::int DESC NULLS LAST,
               updated_at DESC
      LIMIT $2`,
    [`${scope}/%`, limit]
  );
  return r.rows;
}

export async function listLatestScanRuns(scope: string, limit = 20) {
  const r = await db.query(
    `SELECT id, ts, duration_ms, candidates_count,
            top5_per_chain, top10_overall, summary, scan_page_path, status
       FROM scan_runs
      WHERE scope = $1
      ORDER BY ts DESC
      LIMIT $2`,
    [scope, limit]
  );
  return r.rows;
}

export async function getScanById(id: string) {
  const r = await db.query(`SELECT * FROM scan_runs WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}
