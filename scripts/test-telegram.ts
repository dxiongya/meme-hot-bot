import { installGlobalProxy } from "../src/lib/proxy-env.js";
import { sendTelegram } from "../src/lib/telegram.js";

installGlobalProxy();

const msg = `🧪 <b>crypto-radar telegram test</b>
<code>Hello from your server.</code>

若收到说明推送管线通了。
每次 scan 完成后，自动推送 meme/futures 精简结果到这里。`;

await sendTelegram(msg);
console.log("sent (check your Telegram)");
process.exit(0);
