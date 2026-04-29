import { installGlobalProxy } from "../src/lib/proxy-env.js";
import { twitterSearchTool } from "../src/modules/meme/tools/twitter.js";

installGlobalProxy();

const tests = [
  { query: "MAGA", ca: "9iCzo5S4jqcWEfxrf2ssXk8C8iv4tmTcUMwU5LgEWcmh" },
  { query: "UNCEROID", ca: "B7aDzQPxzxCJCM5RkDL2CQsP4UGzCxdDmP8TFWdPuerP" },
  { query: "BABYASTEROID", ca: "0x0bb212d0f2e29f5ab51bf293f5c57d6c5fde4444" },
  { query: "yourname", ca: "FiaHQNh2GreV5PjC3mJBppvvt9fbHksBhAbmMFar45Fx" },
  { query: "HermesOS", ca: "0x95ccfd2b81a9667b0cc979992632f98fc853eba3" },
];

for (const { query, ca } of tests) {
  console.log(`\n============ ${query} ============`);
  const r = await twitterSearchTool.execute("test", { query, contract_address: ca } as any);
  const d = (r as any).details;
  console.log(`raw=${d.total_raw}  legit=${d.legit}  ca_hits=${d.ca_hits}  uniq=${d.uniq_users}`);
  console.log("rejected:", d.rejected);
  if (d.top_voices?.length) {
    console.log("top_voices:");
    for (const v of d.top_voices) {
      console.log(`  @${v.screen_name} (${v.followers} fl, ${v.account_age_days}d, src=${v.source}): ${v.text.slice(0, 120)}`);
    }
  }
  if (d.suspicious_bot_candidates?.length) {
    console.log("bot_candidates:", d.suspicious_bot_candidates);
  }
}
process.exit(0);
