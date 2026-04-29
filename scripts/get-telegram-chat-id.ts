/**
 * 帮你拿到 Telegram chat_id 的一次性脚本。
 *
 * 用前：先去 @BotFather 创建一个 bot，把 token 写到 .env：
 *   TELEGRAM_BOT_TOKEN=<your-bot-token>
 *
 * 然后：
 *   1. 在 Telegram 搜你创建的 bot
 *   2. 选一种方式：
 *      A) 私聊（通知发给自己）：点 Start 或发任意消息。
 *      B) 群发（通知发到群）：把 bot 加进群，发一条 @<your-bot-name> 提及它。
 *      C) 频道（通知发到频道）：把 bot 加为 channel admin + 发条消息。
 *   3. 运行本脚本。
 */
import { installGlobalProxy } from "../src/lib/proxy-env.js";

installGlobalProxy();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
if (!TOKEN) {
  console.error("❌ Set TELEGRAM_BOT_TOKEN in .env first.");
  process.exit(1);
}

async function main() {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/getUpdates`);
  const data = await res.json() as any;
  if (!data.ok) {
    console.error("❌ getUpdates failed:", data);
    return;
  }
  const ups = data.result ?? [];
  if (ups.length === 0) {
    console.log(`
⚠️ Bot 还没收到过任何消息。

下一步：
  → 私聊给你自己：打开 @where_is_the_hot_spot_bot，点 Start 或发任意消息。
  → 群发：把 bot 加进群，发一条消息 @where_is_the_hot_spot_bot 提及它。
  → 频道：把 bot 加为 channel admin + 发一条消息。

然后再跑一次本脚本。
    `);
    return;
  }

  const seen = new Map<string | number, any>();
  for (const u of ups) {
    const msg = u.message ?? u.channel_post ?? u.edited_message;
    const ch = msg?.chat;
    if (ch?.id && !seen.has(ch.id)) seen.set(ch.id, ch);
  }

  console.log(`\n✅ Bot 能看到 ${seen.size} 个 chat：\n`);
  for (const [cid, ch] of seen) {
    const title = ch.title ?? `${ch.first_name ?? ""} ${ch.last_name ?? ""}`.trim();
    const username = ch.username ? `@${ch.username}` : "";
    console.log(`  chat_id = ${cid}`);
    console.log(`     type = ${ch.type}`);
    console.log(`     name = ${title} ${username}`);
    console.log("");
  }

  console.log(`把你想用的 chat_id 写到 .env：\n    TELEGRAM_CHAT_ID=<chat_id>\n`);
}

main().then(() => process.exit(0));
