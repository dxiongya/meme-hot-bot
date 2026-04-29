/**
 * Preview what gets pushed to Telegram without actually sending.
 */
import { readPage } from "../src/lib/brain/reader.js";
import { formatMemeScanForTelegram } from "../src/lib/telegram.js";

const memePath = process.argv[2] || "meme/scans/2026-04-28/0750.md";
const memePage = await readPage(memePath);

if (memePage) {
  console.log("==================== MEME TELEGRAM PREVIEW ====================");
  const msgs = await formatMemeScanForTelegram(memePage as any, 188000);
  console.log(`(messages=${msgs.length})`);
  msgs.forEach((m, i) => {
    console.log(`\n---- msg ${i + 1} (${m.length} bytes) ----`);
    console.log(m);
  });
} else {
  console.log(`scan page not found: ${memePath}`);
}
process.exit(0);
