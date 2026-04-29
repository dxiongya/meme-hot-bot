import { Hono } from "hono";
import { db } from "../../../db/client.js";
import { readPage } from "../../../lib/brain/reader.js";
import { patternPath, SCOPE } from "../brain-scope.js";

export const patternsApi = new Hono();

patternsApi.get("/", async (c) => {
  const r = await db.query(
    `SELECT path, frontmatter, updated_at
       FROM pages
      WHERE type = 'pattern' AND path LIKE $1
      ORDER BY updated_at DESC`,
    [`${SCOPE}/%`]
  );
  return c.json({ patterns: r.rows });
});

patternsApi.get("/:slug", async (c) => {
  const page = await readPage(patternPath(c.req.param("slug")));
  if (!page) return c.json({ error: "not found" }, 404);
  return c.json(page);
});
