import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { installGlobalProxy } from "./lib/proxy-env.js";

// Meme module
import { scansApi as memeScansApi } from "./modules/meme/api/scans.js";
import { tokensApi as memeTokensApi } from "./modules/meme/api/tokens.js";
import { patternsApi as memePatternsApi } from "./modules/meme/api/patterns.js";
import { jobsApi as memeJobsApi } from "./modules/meme/api/jobs.js";
import { chatApi as memeChatApi } from "./modules/meme/api/chat.js";
import { startScheduler as startMemeScheduler } from "./modules/meme/jobs/scheduler.js";

// Position tracking — virtual paper-trading off scan suggestions
import { startPositionMonitor } from "./modules/positions/index.js";

// Telegram inbound bot — answers CA lookups from the configured chat
import { startTelegramInbound } from "./lib/telegram-inbound.js";

// Premium module — high-bar filtered alerts on a separate bot, with
// 5-min reply-style updates and outcome learning.
import { startPremiumScan } from "./modules/premium/jobs/scan.js";
import { startPremiumMonitor } from "./modules/premium/jobs/monitor.js";

async function bootstrap() {
  installGlobalProxy();  // undici ProxyAgent — affects pi-ai LLM fetches too

  try {
    await db.query("SELECT 1");
    console.log("[db] connected");
  } catch (e) {
    console.error("[db] connection failed", e);
    process.exit(1);
  }

  const app = new Hono();
  app.use("*", logger());
  app.use("/api/*", cors({ origin: "*" }));

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      ts: new Date().toISOString(),
      llm: { provider: config.llm.provider, model: config.llm.model },
      modules: ["meme", "premium"],
    })
  );

  // /api/meme/*  — on-chain meme-coin scanner (gmgn + GeckoTerminal)
  app.route("/api/meme/scans", memeScansApi);
  app.route("/api/meme/tokens", memeTokensApi);
  app.route("/api/meme/patterns", memePatternsApi);
  app.route("/api/meme/jobs", memeJobsApi);
  app.route("/api/meme/chat", memeChatApi);

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`[server] listening on http://localhost:${info.port}`);
  });

  startMemeScheduler();
  startPositionMonitor();
  startTelegramInbound();
  startPremiumScan();
  startPremiumMonitor();
}

bootstrap().catch((e) => { console.error(e); process.exit(1); });

process.on("SIGINT", async () => {
  console.log("\n[server] shutting down");
  await db.end().catch(() => {});
  process.exit(0);
});
