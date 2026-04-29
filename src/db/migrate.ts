import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "./client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sql = readFileSync(resolve(__dirname, "schema.sql"), "utf8");
  console.log("[migrate] applying schema...");
  await db.query(sql);
  console.log("[migrate] done");
  await db.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
