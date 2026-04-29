import { Hono } from "hono";
import { runScan, subscribeScans } from "../jobs/scan.js";
import { streamSSE } from "hono/streaming";

export const jobsApi = new Hono();

jobsApi.post("/scan-now", async (c) => {
  // Fire-and-forget; we just kick the scan and return its id.
  // Clients can subscribe to /api/jobs/events for progress.
  const body = await c.req.json().catch(() => ({} as { chains?: string[] }));
  const chains = body?.chains;
  // do not await — return immediately
  runScan({ chains }).catch((e) => console.error("[runScan]", e));
  return c.json({ ok: true, message: "scan started; subscribe to /api/jobs/events for progress" });
});

jobsApi.get("/events", (c) => {
  return streamSSE(c, async (stream) => {
    const off = subscribeScans((event) => {
      stream.writeSSE({
        event: event.type,
        data: JSON.stringify({ scanId: event.scanId, payload: event.payload }),
      });
    });
    // keep connection alive
    const ping = setInterval(() => stream.writeSSE({ event: "ping", data: "" }).catch(() => {}), 15_000);
    await new Promise<void>((resolve) => {
      const close = () => { off(); clearInterval(ping); resolve(); };
      stream.onAbort(close);
    });
  });
});
