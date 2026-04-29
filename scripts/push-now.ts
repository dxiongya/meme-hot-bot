import { installGlobalProxy } from "../src/lib/proxy-env.js";
import { pushScanPageToTelegram } from "../src/lib/telegram.js";
installGlobalProxy();
const memePath = process.argv[2] || "meme/scans/2026-04-21/1227.md";
await pushScanPageToTelegram("meme", memePath, 188000);
console.log("sent meme");
process.exit(0);
