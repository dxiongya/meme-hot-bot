/**
 * Telegram push via all-pusher-api.
 *
 * Also includes formatters that turn a written scan markdown page into a
 * trimmed Telegram HTML digest (4096 char limit per message).
 */
import { config } from "../config.js";
import { readPage } from "./brain/reader.js";
import { fetchAndRenderKline4h15m } from "./kline.js";

export function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Directly call Telegram Bot API. Bypasses all-pusher-api which silently
 * swallowed sends in testing (message_id counter proved no delivery).
 */
export async function sendTelegram(message: string): Promise<void> {
  if (!config.telegram.enabled) return;
  const { botToken, chatId } = config.telegram;
  if (!botToken || !chatId) {
    console.warn("[telegram] token/chat_id not configured; skipping");
    return;
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !(data as any)?.ok) {
      console.error(`[telegram] send failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
    } else {
      console.log(`[telegram] sent message_id=${(data as any).result?.message_id} (${message.length} chars)`);
    }
  } catch (e: any) {
    console.error(`[telegram] send exception: ${e?.message ?? e}`);
  }
}

// -- Scan formatting helpers ----------------------------------------

function section(body: string, titleRegex: string): string | null {
  // Note: no `m` flag — $ means end-of-input here, so the non-greedy
  // match extends until the next "## " line or end of doc, not end of
  // first line. That bug wiped all section bodies from the digest.
  const rx = new RegExp(`##\\s*${titleRegex}[\\s\\S]*?(?=\\n##\\s|$)`, "i");
  const m = body.match(rx);
  return m ? m[0].trim() : null;
}

function compactMdTable(s: string): string {
  const rows = s
    .split(/\n/)
    .filter((l) => l.trim().startsWith("|") && !/^\|[\s\-|:]+\|$/.test(l));
  if (rows.length === 0) return s;
  const parsed = rows.map((r) =>
    r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim())
  );
  return parsed.map((r) => r.join(" | ")).join("\n");
}

const TELEGRAM_BUDGET = 3900;

function buildDigest(
  header: string,
  content: string,
  sections: Array<{ title: string; heading: string; maxBody?: number }>
): string {
  const parts: string[] = [header];

  for (const { title, heading, maxBody = 900 } of sections) {
    const raw = section(content, title);
    if (!raw) continue;

    let body = raw.replace(/^##\s*.*\n/, "").trim();
    if (/^(None this run\.?|—|-)$/i.test(body.trim())) continue;
    if (body.includes("|")) body = compactMdTable(body);
    if (!body) continue;
    if (body.length > maxBody) body = body.slice(0, maxBody - 20) + "\n…(trimmed)";

    const block = `\n\n<b>${escapeHtml(heading)}</b>\n<pre>${escapeHtml(body)}</pre>`;
    if (parts.join("").length + block.length > TELEGRAM_BUDGET) break;
    parts.push(block);
  }

  return parts.join("");
}

// Parse a markdown pipe table → {headers, rows}
function parseTable(s: string): { headers: string[]; rows: string[][] } | null {
  const lines = s.split(/\n/).filter((l) => l.trim().startsWith("|"));
  if (lines.length < 2) return null;
  const split = (l: string) => l.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const dataLines = lines.filter((l) => !/^\|[\s\-|:]+\|$/.test(l));
  if (dataLines.length < 2) return null;
  return { headers: split(dataLines[0]), rows: dataLines.slice(1).map(split) };
}

function col(headers: string[], rx: RegExp): number {
  return headers.findIndex((h) => rx.test(h));
}

// ── Meme renderer ─────────────────────────────────────────────────────
// New report format: | # | ⭐ | 代币 | CA | 币价 | 热度值 | 讨论量 | 异动 | 链 |
// plus per-candidate "### ⭐⭐ Name (chain) — $price" blocks with 三问 bullets.

interface MemeNarrative {
  what_is?: string;
  direction?: string;
  reason?: string;
  full_ca?: string;    // pulled from "📍 CA: ..." line — untruncated
}

/**
 * Parse the 📝 逐币分析 section. Map key is `symbol@chain` because
 * the same symbol can appear on multiple chains (cross-chain copycats,
 * e.g. w🍖 on eth + w🍖 on base). Keying by symbol alone causes the
 * second block to overwrite the first, so the renderer ends up
 * showing one row's stats with another row's narrative.
 *
 * For back-compat, we also write a bare-`symbol` entry the FIRST time
 * each symbol is seen — that lets single-chain tokens still resolve.
 */
function parseMemeNarratives(section: string | null): Map<string, MemeNarrative> {
  const out = new Map<string, MemeNarrative>();
  if (!section) return out;
  const blocks = section.split(/\n###\s+/).slice(1);
  for (const block of blocks) {
    const firstNl = block.indexOf("\n");
    const head = (firstNl > 0 ? block.slice(0, firstNl) : block).trim();
    const body = firstNl > 0 ? block.slice(firstNl + 1) : "";

    // Heading variants we need to handle:
    //   "🔁 持续 · ⭐⭐⭐ · PEPI (eth) — $61.00"
    //   "🛌 复活 · ⭐⭐ · OPG (bsc) — $0.001"
    //   "🆕 新币 · ⭐ · BOAR (sol) — $0.0001"
    //   "⭐⭐⭐ ASTEROID (sol) — $0.023"   (legacy)
    //   "ASTEROID (sol) — $0.023"        (legacy bare)
    //
    // Strategy: anchor on the symbol-and-chain pattern just before the
    // " — $price" dash. Take the LAST capture in the heading so any
    // amount of leading category/star prefix gets ignored.
    const matches = [...head.matchAll(/([^\s·⭐(（—\-]+(?:\s+[^\s·⭐(（—\-]+)*)\s*[(（]\s*([\w-]+)\s*[)）]/g)];
    let symbol = "";
    let chain = "";
    if (matches.length > 0) {
      const last = matches[matches.length - 1];
      symbol = last[1].trim();
      chain = last[2].trim().toLowerCase();
    } else {
      // Truly unrecognized format — try a permissive fallback: strip
      // leading bullets/emoji/stars/dots, then take up to —/−.
      const stripped = head
        .replace(/^[\s·]*[🔁🛌🆕📈🔥⭐]+[\s·]*/g, "")
        .replace(/^[^A-Za-z0-9\u4e00-\u9fff$_]+/, "")
        .trim();
      const fb = stripped.match(/^([^(—\-]+?)(?:\s*[—\-]|$)/);
      symbol = (fb?.[1] ?? "").trim();
    }
    if (!symbol) continue;

    const pick = (label: string): string | undefined => {
      const rx = new RegExp(
        `(?:^|\\n)\\s*[•\\-*]\\s*\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*([^\\n]+)`,
        "i",
      );
      const x = body.match(rx);
      return x ? x[1].trim() : undefined;
    };

    const caMatch = body.match(/📍\s*CA[:：]?\s*([A-Za-z0-9]{20,})/);
    const full_ca = caMatch ? caMatch[1].trim() : undefined;

    const entry: MemeNarrative = {
      what_is: pick("这是什么币"),
      direction: pick("叙事方向"),
      reason: pick("近期涨因") ?? pick("近期原因"),
      full_ca,
    };
    if (chain) out.set(`${symbol}@${chain}`, entry);
    if (!out.has(symbol)) out.set(symbol, entry);
  }
  return out;
}

/**
 * Strip the leading delta number out of an 异动 cell. The LLM sometimes
 * outputs "📈 -83.47 持续上升" — that -83.47 is the abs-anomaly-score
 * delta (not a price chg) and reads as "−83% drop" to the user, which
 * is misleading when paired with "持续上升". Keep only the symbol +
 * label.
 */
function cleanAnomalyLabel(s: string): string {
  if (!s) return "";
  return s
    .replace(/[+\-−]?\s*\d+(?:\.\d+)?%?/g, "")
    .replace(/[()（）,，]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function renderMemeRow(
  h: string[],
  r: string[],
  narratives: Map<string, MemeNarrative>,
): string | null {
  const iChain = col(h, /^链|chain/i);
  const iName = col(h, /^代币|^name|^symbol/i);
  const iAddr = col(h, /^ca|address|contract/i);
  const iPrice = col(h, /^币价|^price/i);
  const iMcap = col(h, /^市值|mcap|market\s*cap/i);
  const iHeat = col(h, /^热度/);
  const iDisc = col(h, /^讨论/);
  const iAnomaly = col(h, /^异动/);
  const iStar = col(h, /^⭐|^star/i);
  const iAlert = col(h, /^🚨|alert|tier/i);
  const iSmart = col(h, /^智能钱|smart|kol/i);

  const chain = (iChain >= 0 ? r[iChain] : "").toLowerCase().trim();
  const name = (iName >= 0 ? r[iName] : "?").trim();
  const tableAddr = (iAddr >= 0 ? r[iAddr] : "").replace(/[`\s]/g, "").trim();
  if (!name || name === "?") return null;

  const price = iPrice >= 0 ? r[iPrice].trim() : "";
  const mcap = iMcap >= 0 ? r[iMcap].trim() : "";
  const heat = iHeat >= 0 ? r[iHeat].trim() : "";
  const disc = iDisc >= 0 ? r[iDisc].trim() : "";
  const anomalyRaw = iAnomaly >= 0 ? r[iAnomaly].trim() : "";
  const anomaly = cleanAnomalyLabel(anomalyRaw);
  const stars = iStar >= 0 ? r[iStar].trim() : "";
  const alert = iAlert >= 0 ? r[iAlert].trim() : "";
  void alert;
  const smart = iSmart >= 0 ? r[iSmart].trim() : "";
  const narr = narratives.get(`${name}@${chain}`) ?? narratives.get(name);

  const addr = (narr?.full_ca && narr.full_ca.length >= 20)
    ? narr.full_ca
    : (/[…\.]{2,}/.test(tableAddr) ? "" : tableAddr);

  // ── Layout ──
  // Line 1 (verdict): stars · name · chain · 异动 label
  // Line 2 (size):    市值 · 币价 · 🐋 smart
  // Line 3 (CA):      copy-paste contract
  // Line 4-6 (三问):  🚀 涨因 / 🪪 是什么 / 🧭 叙事
  // Line 7 (heat):    热度/讨论 — small footer, low priority
  // (K-line is appended by caller as 2 lines)
  const lines: string[] = [];

  const titleParts: string[] = [`${stars || "🔥"} <b>${escapeHtml(name)}</b>`];
  if (chain) titleParts.push(`<i>${escapeHtml(chain)}</i>`);
  if (anomaly) titleParts.push(escapeHtml(anomaly));
  lines.push(titleParts.join(" · "));

  const sizeParts: string[] = [];
  if (mcap) sizeParts.push(`市值 <b>${escapeHtml(mcap)}</b>`);
  if (price) sizeParts.push(`币价 ${escapeHtml(price)}`);
  if (smart && /smart|kol|=\d/.test(smart)) sizeParts.push(`🐋 ${escapeHtml(smart)}`);
  if (sizeParts.length) lines.push(sizeParts.join(" · "));

  if (addr && addr.length >= 20) {
    lines.push(`CA <code>${escapeHtml(addr)}</code>`);
  }

  if (narr) {
    if (narr.reason) lines.push(`🚀 涨因：${escapeHtml(narr.reason.slice(0, 180))}`);
    if (narr.what_is) lines.push(`🪪 是什么：${escapeHtml(narr.what_is.slice(0, 180))}`);
    if (narr.direction) lines.push(`🧭 叙事：${escapeHtml(narr.direction.slice(0, 180))}`);
  }

  const footer: string[] = [];
  if (heat) footer.push(`热度 ${escapeHtml(heat)}`);
  if (disc) footer.push(`讨论 ${escapeHtml(disc)}`);
  if (footer.length) lines.push(`<i>${footer.join(" · ")}</i>`);

  return lines.join("\n");
}

/**
 * Parse the scan markdown to figure out which symbols are FIRST-TIME
 * (listed under "## 📈 新加入跟踪") and which are CONTINUING-UP
 * (the 异动 cell contains "持续上升" or the ▲ arrow). Returns a lookup
 * so the renderer can classify each candidate into its own message.
 */
function classifyMemeCandidates(content: string, tableHeaders: string[], tableRows: string[][]):
  { newSymbols: Set<string>; upSymbols: Set<string> } {
  const newSymbols = new Set<string>();
  const upSymbols = new Set<string>();

  const newSection = section(content, "📈 新加入跟踪");
  if (newSection) {
    for (const line of newSection.split("\n")) {
      // "- **symbol** (chain) — ..." or "- symbol ..."
      const m = line.match(/^[-*]\s*(?:\*\*)?\s*([^\s(*—`]+)/);
      if (m) newSymbols.add(m[1].trim());
    }
  }

  const iName = tableHeaders.findIndex((h) => /^代币|^name|^symbol/i.test(h));
  const iAnomaly = tableHeaders.findIndex((h) => /^异动/.test(h));
  if (iName >= 0 && iAnomaly >= 0) {
    for (const r of tableRows) {
      const name = (r[iName] ?? "").trim();
      const anomaly = r[iAnomaly] ?? "";
      if (!name) continue;
      if (/持续上升|📈|▲/.test(anomaly)) upSymbols.add(name);
    }
  }
  return { newSymbols, upSymbols };
}

/**
 * Render the "## 🪞 跨链复制币" markdown section into clean Telegram
 * HTML cards (one card per group). Skips raw pipes/dashes/asterisks
 * so the message reads cleanly on mobile.
 */
async function renderCopycatCards(rawSection: string): Promise<string[]> {
  const cards: string[] = [];
  // Split on per-group headings: "### 🪞 NAME — X 链同名…"
  const blocks = rawSection.split(/\n###\s+/).slice(1);

  // First pass: collect all (chain, CA) pairs across every group so we
  // can parallel-fetch all K-lines once. ~1-2s total via gmgn-cli even
  // for 6-9 distinct members across ~3 groups.
  type Member = { chain: string; ca: string };
  const blocksWithMembers: Array<{ block: string; members: Member[] }> = [];
  for (const block of blocks) {
    const members: Member[] = [];
    for (const line of block.split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      if (/^\|[\s\-|:]+\|$/.test(line.trim())) continue;
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.length < 2) continue;
      if (/^链$|chain/i.test(cells[0])) continue;
      const chain = String(cells[0] ?? "").toLowerCase();
      const ca = String(cells[1] ?? "").replace(/[`\s]/g, "");
      if (chain && ca && ca.length >= 20) members.push({ chain, ca });
    }
    blocksWithMembers.push({ block, members });
  }
  const allMembers: Member[] = blocksWithMembers.flatMap((b) => b.members);
  const klineMap = new Map<string, string>();
  await Promise.all(
    allMembers.map(async (m) => {
      try {
        const kl = await fetchAndRenderKline4h15m(m.chain, m.ca);
        if (kl) klineMap.set(`${m.chain}:${m.ca}`, kl);
      } catch { /* skip */ }
    }),
  );

  for (const { block } of blocksWithMembers) {
    const firstNl = block.indexOf("\n");
    const heading = (firstNl > 0 ? block.slice(0, firstNl) : block).trim();
    const body = firstNl > 0 ? block.slice(firstNl + 1) : "";

    // Extract group name from "🪞 NAME — N 链同名…"
    const titleMatch = heading.match(/^🪞?\s*([^—\-]+?)\s*[—\-]\s*(.+)$/);
    const sym = (titleMatch?.[1] ?? "?").trim();
    const meta = (titleMatch?.[2] ?? "").trim();

    // Extract per-chain table rows: "| eth | 0xabc... | $0.00 | $1M | +5% | 3 | 1 | ✅ 干净 |"
    const tableRows: Array<{ chain: string; ca: string; price: string; mcap: string; chg: string; smart: string; kol: string; risk: string }> = [];
    for (const line of body.split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      if (/^\|[\s\-|:]+\|$/.test(line.trim())) continue;          // separator
      const cells = line.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      if (cells.length < 5) continue;
      // Skip header row ("链 | CA | …")
      if (/^链$|chain/i.test(cells[0])) continue;
      tableRows.push({
        chain: cells[0] ?? "?",
        ca: (cells[1] ?? "").replace(/[`\s]/g, ""),
        price: cells[2] ?? "",
        mcap: cells[3] ?? "",
        chg: cells[4] ?? "",
        smart: cells[5] ?? "",
        kol: cells[6] ?? "",
        risk: cells[7] ?? "",
      });
    }

    // Extract narrative bullets — same pattern as parseMemeNarratives
    const pick = (label: string): string | undefined => {
      const rx = new RegExp(
        `(?:^|\\n)\\s*[•\\-*]\\s*\\*{0,2}${label}\\*{0,2}\\s*[:：]\\s*([^\\n]+)`,
        "i",
      );
      const m = body.match(rx);
      return m ? m[1].trim().replace(/\*\*/g, "") : undefined;
    };
    const what = pick("这是什么币");
    const direction = pick("叙事方向");
    const reason = pick("近期涨因") ?? pick("近期原因");
    const risk = pick("风险提示");

    const lines: string[] = [];
    lines.push(`🪞 <b>${escapeHtml(sym)}</b>${meta ? ` · <i>${escapeHtml(meta)}</i>` : ""}`);
    for (const r of tableRows) {
      // Flag a chain whose 1h is crashing — copycat header brags about
      // "聪明钱 35 次买入" but eth might be -60%, which the user needs
      // to see at a glance, not read three lines down.
      const chgNum = parseFloat(r.chg.replace(/[^0-9.+-]/g, ""));
      const crashEmoji = isFinite(chgNum) && chgNum <= -10 ? "📉 " : "";

      const head: string[] = [`${crashEmoji}<b>${escapeHtml(r.chain)}</b>`];
      if (r.mcap) head.push(`市值 <b>${escapeHtml(r.mcap)}</b>`);
      if (r.chg) head.push(`1h ${escapeHtml(r.chg)}`);
      if (r.price) head.push(escapeHtml(r.price));
      const tags: string[] = [];
      if (r.smart && r.smart !== "0") tags.push(`🐋${escapeHtml(r.smart)}`);
      if (r.kol && r.kol !== "0") tags.push(`KOL${escapeHtml(r.kol)}`);
      if (r.risk) tags.push(escapeHtml(r.risk));
      if (tags.length) head.push(tags.join(" "));
      lines.push(`  • ${head.join(" · ")}`);
      if (r.ca && r.ca.length >= 20) {
        lines.push(`    CA <code>${escapeHtml(r.ca)}</code>`);
      }
      const kl = klineMap.get(`${r.chain.toLowerCase()}:${r.ca.toLowerCase()}`)
              ?? klineMap.get(`${r.chain.toLowerCase()}:${r.ca}`);   // sol = case-sensitive
      if (kl) {
        lines.push(...kl.split("\n").map((s) => `    ${s}`));
      }
    }
    if (reason) lines.push(`🚀 涨因：${escapeHtml(reason.slice(0, 260))}`);
    if (what) lines.push(`🪪 是什么：${escapeHtml(what.slice(0, 220))}`);
    if (direction) lines.push(`🧭 叙事：${escapeHtml(direction.slice(0, 220))}`);
    if (risk) lines.push(`⚠️ 风险：${escapeHtml(risk.slice(0, 220))}`);

    cards.push(lines.join("\n"));
  }
  return cards;
}

/**
 * Returns an array of Telegram messages (one per category). The sender
 * pushes them sequentially so the user sees 🆕/📈/📊 as separate
 * notifications instead of one giant wall of text.
 */
export async function formatMemeScanForTelegram(page: {
  frontmatter: Record<string, any>;
  content: string;
  path: string;
}, scanDurationMs?: number): Promise<string[]> {
  const { content, path } = page;
  const dur = scanDurationMs ? `${Math.round(scanDurationMs / 1000)}s` : "";

  const topRaw =
    section(content, "🔥 值得报告的候选") ??
    section(content, "🔥 Top 异动候选") ??
    section(content, "🔥 Fresh Breakouts");
  const narrativeRaw = section(content, "📝 逐币分析");
  const narratives = parseMemeNarratives(narrativeRaw);

  // Three explicit alert categories (per user rule); everything else is
  // muted. Category source-of-truth is the "类别" column the scan tool
  // emits — we don't try to infer from prose.
  const buckets = {
    zombie: [] as string[],     // 🛌 老币复活：first sight + age > 30d
    new: [] as string[],        // 🆕 新币拉高：first sight + age < 72h
    continuing: [] as string[], // 🔁 持续上升：known token still pumping
  };
  if (topRaw) {
    const tbl = parseTable(topRaw);
    if (tbl) {
      const iAlert = tbl.headers.findIndex((h) => /^🚨|alert|tier/i.test(h));
      const iCat   = tbl.headers.findIndex((h) => /^类别|category/i.test(h));
      const iName  = tbl.headers.findIndex((h) => /^代币|^name|^symbol/i.test(h));
      const iChain = tbl.headers.findIndex((h) => /^链|chain/i.test(h));

      // First pass: filter to passing rows so we know which klines to fetch
      type Pass = { row: string[]; cat: string; ca: string; chain: string };
      const passing: Pass[] = [];
      for (const r of tbl.rows) {
        if (iAlert >= 0 && !/🔥/.test((r[iAlert] ?? "").trim())) continue;
        const cat = (iCat >= 0 ? r[iCat] : "").trim();
        if (!/zombie|🛌|复活|老币|new|🆕|新币|continuing|🔁|持续/.test(cat)) continue;
        // Need full CA from narratives (table column is truncated)
        const name = iName >= 0 ? (r[iName] ?? "").trim() : "";
        const chain = (iChain >= 0 ? r[iChain] : "").toLowerCase().trim();
        const narr = narratives.get(`${name}@${chain}`) ?? narratives.get(name);
        const ca = narr?.full_ca ?? "";
        if (!ca || !chain) continue;
        passing.push({ row: r, cat, ca, chain });
      }

      // Parallel-fetch klines for all passing rows. ~1s/token via gmgn-cli;
      // 10 rows in parallel is the practical ceiling we'll hit.
      const klineMap = new Map<string, string>();
      await Promise.all(
        passing.map(async (p) => {
          try {
            const block = await fetchAndRenderKline4h15m(p.chain, p.ca);
            if (block) klineMap.set(`${p.chain}:${p.ca}`, block);
          } catch { /* ignore */ }
        }),
      );

      for (const p of passing) {
        const card = renderMemeRow(tbl.headers, p.row, narratives);
        if (!card) continue;
        const kline = klineMap.get(`${p.chain}:${p.ca}`);
        const cardWithKline = kline ? `${card}\n\n${kline}` : card;
        if (/zombie|🛌|复活|老币/.test(p.cat)) buckets.zombie.push(cardWithKline);
        else if (/new|🆕|新币/.test(p.cat)) buckets.new.push(cardWithKline);
        else if (/continuing|🔁|持续/.test(p.cat)) buckets.continuing.push(cardWithKline);
      }
    }
  }

  // Nothing in any bucket → terse empty message
  const totalCards = buckets.zombie.length + buckets.new.length + buckets.continuing.length;
  if (totalCards === 0) {
    return [
      `🟣 <b>Meme 扫描</b> · 本轮无重点信号 · ${dur}` +
      `\n💡 没有"老币复活 / 新币拉高 / 持续上升"且达 🔥 阈值的候选。` +
      `\n\n<code>${escapeHtml(path)}</code>`,
    ];
  }

  const out: string[] = [];
  const pushBucket = (header: string, cards: string[]) => {
    if (cards.length === 0) return;
    const firstLine = `${header} · ${cards.length} 个 · ${dur}`;
    const footer = `\n<code>${escapeHtml(path)}</code>`;
    const parts: string[] = [firstLine];
    let used = firstLine.length + footer.length + 4;
    for (const c of cards) {
      const block = `\n\n${c}`;
      if (used + block.length > TELEGRAM_BUDGET) break;
      parts.push(block);
      used += block.length;
    }
    parts.push(footer);
    out.push(parts.join(""));
  };

  pushBucket("🛌 <b>Meme 老币复活</b>", buckets.zombie);
  pushBucket("🆕 <b>Meme 新币拉高</b>", buckets.new);
  pushBucket("🔁 <b>Meme 持续上升</b>", buckets.continuing);

  // 🪞 Cross-chain copycats — render each group as a clean Telegram
  // card instead of dumping raw markdown (pipes/asterisks/dashes look
  // ugly when escaped). For each `### 🪞 NAME` block we extract:
  //   - heading + chain count + smart-money total
  //   - the 涉及链 line
  //   - per-chain rows from the markdown table → click-to-copy CA list
  //   - the 4 bullet lines (这是什么币 / 叙事方向 / 近期涨因 / 风险提示)
  const copycatRaw = section(content, "🪞 跨链复制币");
  if (copycatRaw) {
    const cards = await renderCopycatCards(copycatRaw);
    if (cards.length > 0) {
      const headerLine = `🪞 <b>Meme 跨链复制币</b> · ${cards.length} 组 · ${dur}`;
      const footer = `\n<code>${escapeHtml(path)}</code>`;
      const parts: string[] = [headerLine];
      let used = headerLine.length + footer.length + 4;
      for (const c of cards) {
        const block = `\n\n${c}`;
        if (used + block.length > TELEGRAM_BUDGET) break;
        parts.push(block);
        used += block.length;
      }
      parts.push(footer);
      out.push(parts.join(""));
    }
  }

  // If NO bucket had anything, tell user nothing was worth alerting
  if (out.length === 0) {
    out.push(
      `🟣 <b>Meme 扫描</b> · 本轮无新增/持续上升 · ${dur}` +
      `\n<code>${escapeHtml(path)}</code>`,
    );
  }
  return out;
}

export async function pushScanPageToTelegram(
  scope: "meme",
  scanPagePath: string,
  durationMs?: number
): Promise<void> {
  const page = await readPage(scanPagePath);
  if (!page) {
    console.warn(`[telegram] scan page not found: ${scanPagePath}`);
    return;
  }
  void scope;   // single-scope for now; param kept for future modules
  const messages = await formatMemeScanForTelegram(page as any, durationMs);
  for (let i = 0; i < messages.length; i++) {
    await sendTelegram(messages[i]);
    // Space sends ~300ms apart so mobile shows them as distinct
    // notifications and Telegram's 30 msg/sec group-chat ceiling doesn't trip.
    if (i < messages.length - 1) await new Promise((r) => setTimeout(r, 350));
  }
}
