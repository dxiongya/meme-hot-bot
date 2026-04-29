import { runScan } from "../src/modules/meme/jobs/scan.js";
import { db } from "../src/db/client.js";

const r = await runScan();
console.log(JSON.stringify(r, null, 2));
await db.end();
