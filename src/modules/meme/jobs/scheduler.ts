import cron from "node-cron";
import { config } from "../../../config.js";
import { runScan } from "./scan.js";

let inflight = false;

export function startScheduler() {
  if (!config.scan.autoStart) {
    console.log("[scheduler] autoStart disabled");
    return;
  }
  if (!cron.validate(config.scan.cron)) {
    throw new Error(`Invalid SCAN_CRON: ${config.scan.cron}`);
  }
  console.log(`[scheduler] enabled, cron="${config.scan.cron}", chains=${config.scan.chains.join(",")}`);
  cron.schedule(config.scan.cron, async () => {
    if (inflight) {
      console.log("[scheduler] previous scan still running, skipping tick");
      return;
    }
    inflight = true;
    try {
      const r = await runScan();
      console.log(`[scheduler] scan ${r.scanId} ${r.status} in ${r.durationMs}ms${r.scanPagePath ? ` → ${r.scanPagePath}` : ""}`);
    } catch (e) {
      console.error("[scheduler] scan failed:", e);
    } finally {
      inflight = false;
    }
  });
}
