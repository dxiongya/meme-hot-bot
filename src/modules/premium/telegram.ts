/**
 * Premium telegram push — independent bot, separate channel.
 *
 * Format mirrors the main meme card layout (header → narrative →
 * footer with blank-line separators) but tagged "💎 精品" up top so
 * the user can tell at a glance which channel they're reading.
 *
 * Per-card K-line is appended via fetchAndRenderKline4h15m so the
 * trajectory is visible inline.
 */
import { config } from "../../config.js";
import { fetchAndRenderKline4h15m } from "../../lib/kline.js";
import type { ClusterPick } from "./chain-picker.js";

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtUsd(n: number): string {
  if (!isFinite(n) || n === 0) return "?";
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(2)}B`;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtPrice(p: number): string {
  if (!isFinite(p) || p === 0) return "?";
  if (p >= 1) return `$${p.toPrecision(4)}`;
  if (p >= 0.0001) return `$${p.toFixed(6)}`;
  return `$${p.toPrecision(4)}`;
}

const TELEGRAM_BUDGET = 3900;

export async function sendPremiumTelegram(
  message: string,
  opts?: { reply_to_message_id?: number },
): Promise<number | null> {
  const { premiumBotToken, premiumChatId } = config.telegram;
  if (!premiumBotToken || !premiumChatId) {
    console.warn("[premium tg] token/chat_id not set; skipping");
    return null;
  }
  try {
    const body: any = {
      chat_id: premiumChatId,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    };
    if (opts?.reply_to_message_id) {
      body.reply_to_message_id = opts.reply_to_message_id;
      body.allow_sending_without_reply = true;        // don't fail if original is gone
    }
    const res = await fetch(`https://api.telegram.org/bot${premiumBotToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !(data as any)?.ok) {
      console.error(`[premium tg] send failed HTTP ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
      return null;
    }
    const mid = (data as any).result?.message_id ?? null;
    console.log(`[premium tg] sent message_id=${mid} (${message.length} chars${opts?.reply_to_message_id ? `, reply_to=${opts.reply_to_message_id}` : ""})`);
    return mid;
  } catch (e: any) {
    console.error(`[premium tg] send exception: ${e?.message ?? e}`);
    return null;
  }
}

async function renderPickCard(pick: ClusterPick): Promise<string> {
  const c = pick.leader;
  const s = c.last_safety || {};
  const smart = Number(s.smart_degen_count ?? 0);
  const kol = Number(s.renowned_count ?? 0);
  const chg1h = Number(s.chg1h ?? 0);
  const chgEmoji = chg1h >= 50 ? "🔥" : chg1h >= 10 ? "📈" : chg1h <= -10 ? "📉" : "→";

  const sections: string[][] = [];

  // Header
  const header: string[] = [];
  const titleParts: string[] = [`💎 <b>${escapeHtml(c.symbol ?? "?")}</b>`, `<i>${escapeHtml(c.chain)}</i>`];
  titleParts.push(`${chgEmoji} <b>1h ${chg1h >= 0 ? "+" : ""}${chg1h.toFixed(1)}%</b>`);
  header.push(titleParts.join(" · "));

  const sizeParts: string[] = [
    `市值 <b>${fmtUsd(c.last_market_cap)}</b>`,
    `币价 <b>${fmtPrice(c.last_price)}</b>`,
    `🐋 <b>smart=${smart} kol=${kol}</b>`,
  ];
  header.push(sizeParts.join(" · "));

  if (pick.cluster_size > 1) {
    header.push(`🪞 跨链同名 ${pick.cluster_size} 个 (本轮 leader: <b>${escapeHtml(c.chain)}</b>)`);
  }
  header.push(`📋 CA · <i>点击复制</i>\n<code>${escapeHtml(c.address)}</code>`);
  sections.push(header);

  // Narrative
  const narrative: string[] = [];
  if (c.recent_reason) narrative.push(`🚀 <b>涨因</b>：${escapeHtml(c.recent_reason.slice(0, 200))}`);
  if (c.narrative_what_is) narrative.push(`🪪 <b>是什么</b>：${escapeHtml(c.narrative_what_is.slice(0, 200))}`);
  if (c.narrative_direction) narrative.push(`🧭 <b>叙事</b>：${escapeHtml(c.narrative_direction.slice(0, 200))}`);
  if (narrative.length) sections.push(narrative);

  // Footer (selection rationale + small stats)
  const footer: string[] = [];
  footer.push(`<i>选取理由：${escapeHtml(pick.chosen_reason)}</i>`);
  sections.push(footer);

  let card = sections.map((s) => s.join("\n")).join("\n\n");

  // K-line
  try {
    const kl = await fetchAndRenderKline4h15m(c.chain, c.address);
    if (kl) card += `\n\n${kl}`;
  } catch { /* ignore k-line failure */ }

  return card;
}

/**
 * Push each pick as ITS OWN message so we get a stable message_id per
 * token. Bundled multi-card messages would force us to reply to the
 * first card in the bundle for ALL update events, which is confusing.
 *
 * Returns map keyed by `${chain}:${address}` → message_id, so the
 * caller can persist it on the matching premium_signals row.
 */
export async function pushPremiumPicks(picks: ClusterPick[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (picks.length === 0) {
    console.log("[premium tg] no picks this round; skipping");
    return out;
  }
  // Optional summary header — sent once. Skipped when single pick to
  // avoid noise.
  if (picks.length > 1) {
    await sendPremiumTelegram(`💎 <b>大雄 MEME 精品屋</b> · 本轮 ${picks.length} 个新候选`);
    await new Promise((r) => setTimeout(r, 250));
  }
  for (const p of picks) {
    const card = await renderPickCard(p);
    const mid = await sendPremiumTelegram(card);
    if (mid) out.set(`${p.leader.chain}:${p.leader.address}`, mid);
    // Telegram group-chat ceiling = 30/sec; space sends ~300ms apart so
    // mobile renders them as distinct notifications.
    await new Promise((r) => setTimeout(r, 350));
  }
  return out;
}

/**
 * Render an update reply — short follow-up that quotes the original
 * card. Used by the 5-min monitor when a pushed token has a material
 * change (price, new catalyst, key-entity mention).
 */
export async function sendPremiumUpdate(
  reply_to_message_id: number,
  body: string,
): Promise<number | null> {
  return sendPremiumTelegram(body, { reply_to_message_id });
}
