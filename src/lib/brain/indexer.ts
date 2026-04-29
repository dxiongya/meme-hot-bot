import { db } from "../../db/client.js";

export interface PageIndexInput {
  path: string;
  type: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

/**
 * Upsert a page row + recompute FTS tsvector.
 * Embedding is left null until an embedding worker fills it (Phase A keeps
 * search keyword-only; vector layer is plug-in for Phase B).
 */
export async function upsertPageIndex(p: PageIndexInput): Promise<void> {
  await db.query(
    `INSERT INTO pages (path, type, frontmatter, content, fts, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, to_tsvector('simple', $4), NOW())
     ON CONFLICT (path) DO UPDATE SET
       type = EXCLUDED.type,
       frontmatter = EXCLUDED.frontmatter,
       content = EXCLUDED.content,
       fts = to_tsvector('simple', EXCLUDED.content),
       updated_at = NOW()`,
    [p.path, p.type, JSON.stringify(p.frontmatter), p.content]
  );
}

export async function deletePageIndex(path: string): Promise<void> {
  await db.query(`DELETE FROM pages WHERE path = $1`, [path]);
}
