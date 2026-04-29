import { Hono } from "hono";
import { db } from "../../../db/client.js";
import { listMemeStarredTokens, getMemeTokenPage, SCOPE } from "../brain-scope.js";

export const tokensApi = new Hono();

tokensApi.get("/", async (c) => {
  const chain = c.req.query("chain");
  const starred = c.req.query("starred") === "true";
  const limit = parseInt(c.req.query("limit") ?? "50", 10);

  if (starred) return c.json({ tokens: await listMemeStarredTokens(limit) });

  const params: unknown[] = [`${SCOPE}/%`];
  let where = `type = 'token' AND path LIKE $1`;
  if (chain) {
    params.push(chain);
    where += ` AND frontmatter ->> 'chain' = $${params.length}`;
  }
  params.push(limit);
  const r = await db.query(
    `SELECT path, frontmatter, updated_at
       FROM pages
      WHERE ${where}
      ORDER BY updated_at DESC
      LIMIT $${params.length}`,
    params
  );
  return c.json({ tokens: r.rows });
});

tokensApi.get("/:chain/:address", async (c) => {
  const { chain, address } = c.req.param();
  const page = await getMemeTokenPage(chain, address);
  if (!page) return c.json({ error: "not found", chain, address }, 404);
  return c.json(page);
});
