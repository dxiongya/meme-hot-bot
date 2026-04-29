import { installGlobalProxy } from "../src/lib/proxy-env.js";
import { aveTrendingTool } from "../src/modules/meme/tools/ave.js";

installGlobalProxy();
console.log("--- schema ---");
console.log(JSON.stringify(aveTrendingTool.parameters, null, 2));
console.log("\n--- run with {chain:eth, page_size:10} ---");
try {
  const r: any = await aveTrendingTool.execute("t", { chain: "eth", page_size: 10 } as any);
  console.log("content:", JSON.stringify(r.content).slice(0, 200));
  console.log("details keys:", Object.keys(r.details as any).slice(0, 10));
} catch (e: any) {
  console.error("ERR:", e.message);
}

console.log("\n--- run with {chain:eth} only (LLM might skip page_size) ---");
try {
  const r: any = await aveTrendingTool.execute("t", { chain: "eth" } as any);
  console.log("OK");
} catch (e: any) {
  console.error("ERR:", e.message);
}
process.exit(0);
