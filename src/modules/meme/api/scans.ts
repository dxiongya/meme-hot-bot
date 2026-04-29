import { Hono } from "hono";
import { listMemeLatestScans } from "../brain-scope.js";
import { getScanById } from "../../../lib/brain/search.js";
import { readPage } from "../../../lib/brain/reader.js";

export const scansApi = new Hono();

scansApi.get("/", async (c) => {
  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  return c.json({ scans: await listMemeLatestScans(limit) });
});

scansApi.get("/:id", async (c) => {
  const scan = await getScanById(c.req.param("id"));
  if (!scan) return c.json({ error: "not found" }, 404);
  const page = scan.scan_page_path ? await readPage(scan.scan_page_path) : null;
  return c.json({ scan, page });
});
