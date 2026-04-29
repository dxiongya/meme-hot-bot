/**
 * Telegram inbound bot — long-poll getUpdates, watch the configured
 * chat for messages containing a contract address, and reply with:
 *
 *   1. Token detail card (price, pools, creator, LP lock, risk signals)
 *   2. 三问 analyzer output (是什么 / 叙事 / 涨因)
 *   3. Top-10 tweets ranked by quality (same scoring as the scan
 *      pipeline: explanatory content beats hype, follower count is
 *      a tie-breaker not the lead).
 *
 * Only responds to messages from `config.telegram.chatId` — silently
 * ignores anyone else, so a leaked bot token can't be abused for free
 * compute. Idempotent: the long-poll `offset` makes sure each update
 * is processed exactly once even across server restarts (we read the
 * offset from /getUpdates' response — Telegram persists the queue).
 */
import { config } from "../config.js";
import { fetchTokenDetail, renderTokenDetailForTelegram } from "./token-detail.js";
import { xapiTwitterSearch } from "./xapi.js";
import { analyzeBatch, type BatchItem } from "../modules/meme/analyzer.js";
import { sendTelegram, escapeHtml } from "./telegram.js";
import { db } from "../db/client.js";
import { fetchAndRenderKline4h15m } from "./kline.js";

/**
 * Pull this CA's last 3 price snapshots (most recent first) so we
 * can show "since last query …%". Only called from the inbound bot.
 */
async function fetchPriceHistory(ca: string): Promise<Array<{ ts: Date; price: number | null; mcap: number | null }>> {
  try {
    const { rows } = await db.query(
      `SELECT ts, price, mcap FROM inbound_price_log
        WHERE ca = $1 ORDER BY ts DESC LIMIT 3`,
      [ca],
    );
    return rows.map((r: any) => ({
      ts: r.ts as Date,
      price: r.price == null ? null : Number(r.price),
      mcap: r.mcap == null ? null : Number(r.mcap),
    }));
  } catch (e) {
    console.error("[telegram-in] fetchPriceHistory:", e);
    return [];
  }
}

async function logPriceSnapshot(ca: string, price: number | null, mcap: number | null): Promise<void> {
  try {
    await db.query(
      `INSERT INTO inbound_price_log (ca, price, mcap) VALUES ($1, $2, $3)`,
      [ca, price, mcap],
    );
  } catch (e) {
    console.error("[telegram-in] logPriceSnapshot:", e);
  }
}

function fmtAge(ms: number): string {
  if (ms < 0) return "?";
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86400_000) return `${Math.round(ms / 3600_000)}h`;
  return `${Math.round(ms / 86400_000)}d`;
}

function fmtPctDelta(d: number): string {
  const arrow = d > 1 ? "📈" : d < -1 ? "📉" : "→";
  const sign = d >= 0 ? "+" : "";
  return `${arrow} ${sign}${d.toFixed(d >= 100 ? 0 : 1)}%`;
}

/**
 * Build a "since-last-query" delta block. Compares current price
 * against the last logged snapshot (within reasonable window). Returns
 * empty string if no prior history.
 */
function buildPriceDeltaBlock(
  history: Array<{ ts: Date; price: number | null }>,
  currentPrice: number | null,
): string {
  if (history.length === 0 || currentPrice == null || !isFinite(currentPrice)) return "";
  const lines: string[] = [`<b>📊 价格走势（与历史查询对比）</b>`];
  const now = Date.now();
  for (let i = 0; i < Math.min(history.length, 3); i++) {
    const h = history[i];
    if (h.price == null || !isFinite(h.price) || h.price === 0) continue;
    const ageMs = now - h.ts.getTime();
    const pct = ((currentPrice - h.price) / h.price) * 100;
    lines.push(
      `${i + 1}. ${fmtAge(ageMs)}前查询: $${h.price.toPrecision(4)} → 现在 $${currentPrice.toPrecision(4)} ${fmtPctDelta(pct)}`,
    );
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/**
 * Detect whether a tweet body needs Chinese translation. Heuristic:
 * if the text has minimal CJK characters AND ≥ 25 ASCII letters, it's
 * likely English/other-Latin and worth translating. Pure Chinese,
 * pure-emoji-spam, or short bursts get skipped.
 */
function needsTranslation(text: string): boolean {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const ascii = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk < 5 && ascii >= 25;
}

/**
 * Batch-translate up to N tweets to Chinese in ONE LLM call.
 * Returns a Map keyed by the input id → translated text. Skips items
 * already in Chinese (callers can filter via `needsTranslation`
 * beforehand to save tokens).
 *
 * Why batch: 10 tweets × 1 call ≈ 1 LLM round-trip, vs 10 round-trips.
 * Critical for keeping the bot responsive.
 */
async function translateTweets(
  items: Array<{ id: string; text: string }>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (items.length === 0) return out;
  const apiKey = config.llm.getApiKey("deepseek") || config.llm.getApiKey("glm");
  if (!apiKey) return out;
  const baseUrl = config.llm.getApiKey("deepseek")
    ? "https://api.deepseek.com/chat/completions"
    : "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  const model = config.llm.getApiKey("deepseek") ? "deepseek-v4-flash" : "glm-4-flash";

  const sections = items.map((t, i) =>
    `[${i + 1}] id=${t.id}\n${String(t.text).slice(0, 400).replace(/\s+/g, " ")}`,
  ).join("\n\n---\n\n");

  const prompt = [
    `把下面 ${items.length} 条推文翻译成简体中文。`,
    `规则：`,
    `- 保留 \$符号、@用户名、URL、数字与单位（如 $1B, 5x）原样不译`,
    `- 加密黑话保留：mcap / liq / pumpfun / DM / dyor / NFA 直接保留英文`,
    `- 自然中文，不要逐字翻译`,
    `- 严格按输入顺序输出 JSON 数组：[{"id":"xxx","zh":"..."}]`,
    `- 只输出 JSON 数组，不要任何 markdown / 解释`,
    ``,
    `推文：`,
    sections,
  ].join("\n");

  try {
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: Math.min(300 * items.length + 1500, 12_000),
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(40_000),
    });
    if (!res.ok) {
      console.error(`[telegram-in/translate] HTTP ${res.status}`);
      return out;
    }
    const data: any = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const m = String(raw).match(/\[[\s\S]*\]/);
    if (!m) {
      console.error("[telegram-in/translate] no JSON array in response");
      return out;
    }
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return out;
    for (const e of parsed) {
      if (!e?.id || typeof e.zh !== "string") continue;
      out.set(String(e.id), String(e.zh).trim());
    }
    return out;
  } catch (e: any) {
    console.error("[telegram-in/translate] error:", e?.message ?? e);
    return out;
  }
}

let offset = 0;
let running = false;

// EVM contract: 0x + 40 hex chars
const EVM_RE = /\b0x[a-fA-F0-9]{40}\b/;
// Solana mint: base58, length 32-44, no 0/I/O/l
const SOL_RE = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

export function startTelegramInbound(): void {
  if (!config.telegram.enabled) {
    console.log("[telegram-in] disabled (TELEGRAM_ENABLED=false)");
    return;
  }
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) {
    console.log("[telegram-in] no bot token / chat id, skipping");
    return;
  }
  if (running) return;
  running = true;
  console.log(`[telegram-in] long-poll loop starting (chat ${chatId})`);
  loop().catch((e) => {
    console.error("[telegram-in] loop crashed:", e);
    running = false;
  });
}

async function loop(): Promise<void> {
  const { botToken, chatId } = config.telegram;
  while (running) {
    try {
      const url = `https://api.telegram.org/bot${botToken}/getUpdates?timeout=25&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(35_000) });
      const data: any = await res.json().catch(() => ({}));
      if (!data?.ok) {
        if (data?.error_code) console.error(`[telegram-in] getUpdates error_code=${data.error_code}: ${data.description}`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      for (const upd of data.result ?? []) {
        offset = Math.max(offset, Number(upd.update_id) + 1);
        const msg = upd.message;
        const text: string = msg?.text ?? "";
        if (!text) continue;
        if (String(msg.chat?.id) !== String(chatId)) {
          // silent ignore: not the authorized chat
          continue;
        }
        // Spawn handler without blocking the poll loop — multiple CAs
        // back-to-back shouldn't queue.
        handleMessage(text).catch((e) =>
          console.error("[telegram-in] handler error:", e?.message ?? e),
        );
      }
    } catch (e: any) {
      console.error("[telegram-in] poll exception:", e?.message ?? e);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
}

function extractCA(text: string): string | null {
  const evm = text.match(EVM_RE);
  if (evm) return evm[0];
  const sol = text.match(SOL_RE);
  if (sol) return sol[0];
  return null;
}

/**
 * Quality score for ranking inbound-bot's "top-10 tweets" reply.
 * Same intent as the analyzer's tweet sorting: explanatory > hype,
 * length and explanation keywords beat raw follower count.
 */
const HYPE_RX = /\d+\s*[xX×]\s*[✅🚀💎]|✅\s*✅|🚀\s*🚀|💎\s*💎|\bDM\b|\bVIP\b|\bTG\s*fam\b|私聊|拉群|入群|跟单群|early entry|secured profits/i;
const EXPLAIN_RX = /事件\s*[:：]|起源\s*[:：]|感受\s*[:：]|为什么|由于|因为|是.*的(简称|缩写|名字|代名|代号)|来自|跟随|借势|借用|衍生|关联|换头像|换横幅|宣布|发推|爆料|公告|launched|announced|due to|because|inspired by|origin/i;
function tweetQuality(t: any): number {
  const text = String(t.text ?? "");
  const len = text.length;
  let s = 0;
  if (len > 200) s += 4;
  else if (len > 100) s += 2;
  else if (len > 50) s += 1;
  if (EXPLAIN_RX.test(text)) s += 6;
  if (HYPE_RX.test(text)) s -= 6;
  s += Math.log10(Number(t.user?.followers_count ?? 0) + 10);
  return s;
}

/**
 * Pull the bare @handle out of various forms gmgn / dexscreener give
 * us: "@unicurvefun", "https://x.com/unicurvefun", "twitter.com/foo/?x=1".
 */
function extractTwitterHandle(v: string): string | null {
  if (!v) return null;
  const m = v.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})\b/i)
        ?? v.match(/^@?([A-Za-z0-9_]{1,15})$/);
  return m ? m[1] : null;
}

/**
 * Cap how many tweets a single author can occupy in the Top-10. One
 * shiller spamming "Pumpfun of EVM 0xD400…" 4 times in a row
 * crowds out the actual diverse signals — limit each author to 2.
 */
function capPerAuthor<T extends { user?: { screen_name?: string } }>(
  tweets: T[],
  perAuthor = 2,
): T[] {
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const t of tweets) {
    const a = String(t.user?.screen_name ?? "").toLowerCase();
    if (!a) { out.push(t); continue; }
    const n = counts.get(a) ?? 0;
    if (n >= perAuthor) continue;
    counts.set(a, n + 1);
    out.push(t);
  }
  return out;
}

function ageLabel(iso: string | undefined): string {
  if (!iso) return "?";
  const t = Date.parse(iso);
  if (!t) return "?";
  const h = (Date.now() - t) / 3_600_000;
  if (h < 1) return `${Math.round(h * 60)}m前`;
  if (h < 24) return `${Math.round(h)}h前`;
  const d = h / 24;
  return `${Math.round(d)}d前`;
}

async function handleMessage(text: string): Promise<void> {
  const ca = extractCA(text);
  if (!ca) return;   // no CA found → silent

  console.log(`[telegram-in] CA recognized: ${ca}`);
  await sendTelegram(`🔎 正在分析 <code>${escapeHtml(ca)}</code> ...`);

  // Detail first to learn the symbol + official twitter handle
  const detail = await fetchTokenDetail(ca).catch((e) => {
    console.error("[telegram-in] detail:", e);
    return null;
  });

  if (!detail) {
    await sendTelegram(
      `❌ <code>${escapeHtml(ca)}</code> 找不到 DEX pair / 不在我们覆盖的链上 (eth/base/bsc/sol)`,
    );
    return;
  }

  // Triple-source twitter search to catch every angle:
  //   1. Tweets mentioning the full CA (community / shillers)
  //   2. Tweets FROM the project's official handle (most authoritative)
  //   3. Tweets mentioning $SYMBOL (KOL discussion that doesn't bother
  //      pasting the CA)
  // Then dedupe by tweet_id; the per-author cap below handles repeat
  // posters that flood any single search.
  const handleQ = detail.twitter ? extractTwitterHandle(detail.twitter) : null;
  const symbolQ = detail.symbol && detail.symbol !== "?" ? `$${detail.symbol}` : null;
  const [byCa, byHandle, bySymbol] = await Promise.all([
    xapiTwitterSearch(ca).catch(() => [] as any[]),
    handleQ ? xapiTwitterSearch(`from:${handleQ}`, "Latest").catch(() => [] as any[]) : Promise.resolve([] as any[]),
    symbolQ ? xapiTwitterSearch(symbolQ, "Top").catch(() => [] as any[]) : Promise.resolve([] as any[]),
  ]);
  const seen = new Set<string>();
  const tweets: any[] = [];
  for (const t of [...byHandle, ...byCa, ...bySymbol]) {
    const id = String(t.tweet_id ?? t.id ?? "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    tweets.push(t);
  }
  console.log(`[telegram-in] tweets: ca=${byCa.length} + handle=${byHandle.length} + symbol=${bySymbol.length} → ${tweets.length} unique`);

  // Parallel: price-history lookup + 15m × 4h K-line fetch.
  // Both are cheap, no need to serialize.
  const [history, klineBlock] = await Promise.all([
    fetchPriceHistory(ca),
    fetchAndRenderKline4h15m(detail.chain, ca).catch(() => ""),
  ]);
  const currentPrice = detail.mainPool?.priceUsd ?? null;
  const currentMcap = detail.mcap ?? null;
  await logPriceSnapshot(ca, currentPrice, currentMcap);

  // Message 1: token detail card + K-line + price-trend block
  let card = renderTokenDetailForTelegram(detail);
  if (klineBlock) card += `\n\n${klineBlock}`;
  const trendBlock = buildPriceDeltaBlock(history, currentPrice);
  if (trendBlock) card += `\n\n${trendBlock}`;
  await sendTelegram(card);

  // Message 2: analyzer 三问 (only if we have any material)
  if (tweets.length > 0) {
    const item: BatchItem = {
      key: `${detail.chain}:${ca}`,
      facts: {
        chain: detail.chain,
        symbol: detail.symbol,
        name: detail.name,
        address: ca,
        price: detail.mainPool?.priceUsd ?? null,
        market_cap: detail.mcap ?? null,
        liquidity: detail.totalLiquidityUsd,
        twitter_handle: detail.twitter ?? null,
        website: detail.website ?? null,
        description: null,
      },
      disc: {
        tweet_snippets: tweets.map((t: any) => ({
          author: t.user?.screen_name,
          followers: t.user?.followers_count,
          text: t.text,
          created_at: t.created_at,
        })),
        web_snippets: [],
      },
    };
    try {
      const answers = await analyzeBatch([item]);
      const ans = answers.get(item.key);
      if (ans) {
        const summary: string[] = [`📝 <b>三问分析</b>`];
        if (ans.what_is) summary.push(`🪪 是什么：${escapeHtml(ans.what_is)}`);
        if (ans.narrative_direction) summary.push(`🧭 叙事：${escapeHtml(ans.narrative_direction)}`);
        if (ans.recent_reason) summary.push(`🚀 涨因：${escapeHtml(ans.recent_reason)}`);
        if (ans.catalyst_impact) summary.push(`🎯 催化影响力：<b>${ans.catalyst_impact}/10</b>`);
        await sendTelegram(summary.join("\n"));
      }
    } catch (e: any) {
      console.error("[telegram-in] analyze:", e?.message ?? e);
    }
  }

  // Message 3+: Top-10 tweets by quality, with per-author cap to keep
  // diversity (single shiller can't take 4+ slots).
  if (tweets.length > 0) {
    const sorted = [...tweets].sort((a, b) => tweetQuality(b) - tweetQuality(a));
    const top10 = capPerAuthor(sorted, 2).slice(0, 10);

    // Pre-batch translate any English/Latin-script tweets to Chinese
    // so a non-EN reader can scan the body without copy-paste.
    const toTranslate = top10
      .map((t: any) => ({ id: String(t.tweet_id ?? t.id ?? ""), text: String(t.text ?? "") }))
      .filter((t) => t.id && needsTranslation(t.text));
    const translations = toTranslate.length > 0 ? await translateTweets(toTranslate) : new Map<string, string>();

    const lines: string[] = [`📨 <b>Top 10 推文（按解读质量排序）</b>`];
    for (let i = 0; i < top10.length; i++) {
      const t: any = top10[i];
      const handle = t.user?.screen_name ?? "?";
      const fol = Number(t.user?.followers_count ?? 0);
      const folStr = fol >= 1000 ? `${(fol / 1000).toFixed(1)}k` : `${fol}`;
      const age = ageLabel(t.created_at);
      const link = `https://x.com/${handle}/status/${t.tweet_id ?? t.id ?? ""}`;
      const body = String(t.text ?? "").slice(0, 280).replace(/\s+/g, " ");
      const zh = translations.get(String(t.tweet_id ?? t.id ?? ""));
      const block: string[] = [
        `\n<b>${i + 1}.</b> <a href="${link}">@${escapeHtml(handle)}</a> · ${folStr}粉 · ${age}`,
        `${escapeHtml(body)}`,
      ];
      if (zh) block.push(`<i>🌐 ${escapeHtml(zh.slice(0, 280))}</i>`);
      lines.push(block.join("\n"));
    }
    // Telegram limit 4096 — split if needed
    let chunk: string[] = [];
    let chunkLen = 0;
    const TARGET = 3800;
    for (const ln of lines) {
      if (chunkLen + ln.length + 2 > TARGET && chunk.length > 0) {
        await sendTelegram(chunk.join("\n"));
        chunk = [];
        chunkLen = 0;
      }
      chunk.push(ln);
      chunkLen += ln.length + 2;
    }
    if (chunk.length > 0) await sendTelegram(chunk.join("\n"));
  } else {
    await sendTelegram(`📨 <i>暂无推文（xapi twitter.search 返回空）</i>`);
  }
}
