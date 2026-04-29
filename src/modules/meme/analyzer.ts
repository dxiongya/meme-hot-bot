/**
 * Three-question analyzer — the exact analysis the user asked for:
 *
 *   1. 这是一个什么币？       (what_is)
 *   2. 这个币关于什么叙事方向？ (narrative_direction)
 *   3. 近期又是因为什么涨的？   (recent_reason)
 *
 * One cheap-LLM call per token. Takes the filtered tweet snippets +
 * Google hits + basic on-chain data, returns a structured {what_is,
 * direction, recent_reason}. Failure-tolerant: returns null on any
 * error — caller can decide whether to retry or pass.
 */
import { config } from "../../config.js";

/**
 * Inner-analyzer LLM endpoint. Both the tweet-filter call and the
 * 3-question analyzer batch call use this. Defaults to whatever
 * provider the main agent is configured for (so when LLM_PROVIDER is
 * `deepseek`, the analyzer also goes to DeepSeek).
 *
 * Why not just use pi-ai? These calls are simple JSON-out chat
 * completions — direct fetch is faster to debug than going through the
 * agent runtime, and we control timeouts/retries explicitly.
 */
interface InnerLlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}
function resolveInnerLlm(): InnerLlmConfig {
  const provider = config.llm.provider;
  if (provider === ("deepseek" as any)) {
    return {
      baseUrl: "https://api.deepseek.com/chat/completions",
      apiKey: config.llm.getApiKey("deepseek"),
      // V4-flash is the cheap, fast, non-reasoning workhorse.
      // Override per-call via MEME_ANALYZER_MODEL env if needed.
      model: process.env.MEME_ANALYZER_MODEL ?? "deepseek-v4-flash",
    };
  }
  // Default: GLM (back-compat for existing deployments)
  // glm-4-flash: free-tier, non-reasoning. glm-4-air (¥0.14/M) for paid fallback.
  // Avoid glm-4.5-air / glm-5.1 — they emit `reasoning_content` that
  // burns max_tokens before the JSON output is generated.
  return {
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    apiKey: config.llm.getApiKey("glm"),
    model: process.env.MEME_ANALYZER_MODEL ?? "glm-4-flash",
  };
}

export interface TokenFacts {
  chain: string;
  symbol?: string;
  name?: string;                // display name (may differ from symbol, e.g. "Community Build" vs "共建")
  address: string;
  price?: number | null;
  chg1h?: number | null;
  chg24h?: number | null;
  market_cap?: number | null;
  liquidity?: number | null;
  age_h?: number | null;
  // Project metadata — huge clues for narrative
  twitter_handle?: string | null;
  website?: string | null;
  description?: string | null;  // from gmgn/ave if present
}

export interface DiscussionInput {
  tweet_snippets: Array<{ author?: string; followers?: number; text?: string; created_at?: string }>;
  web_snippets: Array<{ title: string; snippet?: string; date?: string }>;
}

export interface ThreeAnswers {
  what_is: string;
  narrative_direction: string;
  recent_reason: string;
  /**
   * AI's judgment of how impactful the catalyst is on a 1-10 scale,
   * combining (a) intrinsic event significance (who's involved, what
   * institution, what cultural reach) and (b) observed discussion
   * velocity (KOL follower scale, tweet density, cross-language
   * spread). Used downstream as a primary signal for alert tiering.
   *
   * Scale anchors:
   *   10 — head-of-state / Apple keynote / SCOTUS-level event
   *    8-9 — key figure endorsement (X-product-lead, L1 founder buying,
   *          Musk replying to a meme account)
   *    6-7 — mid-circle adoption (50-500k KOL pile-on, VC public hold)
   *    4-5 — routine catalyst (mainnet launch, Alpha listing)
   *    2-3 — weak (small-account shilling, group chat)
   *    1   — pure speculation, no specific event
   *
   * Defaults to 5 (neutral) if the LLM didn't fill it.
   */
  catalyst_impact: number;
}

/**
 * Optionally include a prior analysis so the LLM builds on it instead
 * of re-answering from scratch — supports the user's "incremental
 * analysis: 原有总结 + 补充近期数据" requirement.
 */
export interface PriorAnalysis {
  what_is?: string | null;
  narrative_direction?: string | null;
  recent_reason?: string | null;
  last_analyzed_at?: string | null;
}

function buildPrompt(
  facts: TokenFacts,
  disc: DiscussionInput,
  prior?: PriorAnalysis,
): string {
  const tw = disc.tweet_snippets.slice(0, 8).map((t, i) =>
    `  ${i + 1}. @${t.author ?? "?"} (${t.followers ?? 0} 粉): ${String(t.text ?? "").slice(0, 220).replace(/\s+/g, " ")}`
  ).join("\n");
  const web = disc.web_snippets.slice(0, 6).map((w, i) =>
    `  ${i + 1}. ${w.title} ${w.date ? `[${w.date}]` : ""}\n     ${String(w.snippet ?? "").slice(0, 220).replace(/\s+/g, " ")}`
  ).join("\n");

  const priorBlock = prior && (prior.what_is || prior.narrative_direction || prior.recent_reason)
    ? `\n上次分析（${prior.last_analyzed_at ?? "previous"}）：\n` +
      `  • 是什么：${prior.what_is ?? "未记录"}\n` +
      `  • 叙事：${prior.narrative_direction ?? "未记录"}\n` +
      `  • 近期涨因：${prior.recent_reason ?? "未记录"}\n` +
      `请基于上次总结，结合本轮新增的推文/网络信息，**更新**答案（不变的字段原样带回）。\n`
    : "";

  return [
    `你是一位加密 meme 币研究员。基于下面的事实和讨论材料，用中文回答三个问题，并按严格 JSON 格式返回。`,
    ``,
    `代币基本信息:`,
    `  chain=${facts.chain}  symbol=${facts.symbol ?? "?"}  CA=${facts.address}`,
    `  price=${facts.price ?? "?"}  chg1h=${facts.chg1h ?? "?"}%  chg24h=${facts.chg24h ?? "?"}%`,
    `  mcap=${facts.market_cap ?? "?"}  liq=${facts.liquidity ?? "?"}  age_h=${facts.age_h ?? "?"}`,
    ``,
    `Twitter 讨论片段（${disc.tweet_snippets.length} 条）:`,
    tw || "  （空）",
    ``,
    `Google 搜索结果（${disc.web_snippets.length} 条）:`,
    web || "  （空）",
    priorBlock,
    `请严格返回 JSON，不要加任何解释或 markdown：`,
    `{"what_is":"一句话描述这是什么币（背景/类型/关联人物或事件）","narrative_direction":"一句话讲清楚叙事方向（meme 类型、catalyst、社区特征）","recent_reason":"一句话讲清楚近期涨的具体原因（催化事件/人物/相关热点，必须引用材料支持，没有就写'材料不支持明确结论'）"}`,
    ``,
    `规则:`,
    `- 每个答案不超过 80 个中文字符`,
    `- 禁止编造材料没提到的事实`,
    `- 如果材料不足，如实写"材料不足"`,
  ].join("\n");
}

/**
 * When the LLM gives an answer like "具体催化事件A，社区炒作" we keep only
 * "具体催化事件A" — the trailing filler is noise from its template
 * instincts. If the WHOLE answer is filler, leave it alone (downstream
 * logic already treats those as "needs re-analysis").
 */
function stripFillerTail(s: string): string {
  if (!s) return s;
  const fillerTail =
    /(?:[，,、；;]\s*)(?:社区炒作|纯炒作|情绪驱动|模因币炒作|meme币炒作|需继续观察|材料不足，?需继续观察)\s*[。!！?？]?\s*$/i;
  let cleaned = s;
  // Strip repeatedly in case multiple fillers chain: "X，社区炒作，需继续观察"
  for (let i = 0; i < 3; i++) {
    const next = cleaned.replace(fillerTail, "").trim();
    if (next === cleaned) break;
    cleaned = next;
  }
  return cleaned.length >= 4 ? cleaned : s;   // if strip left us with ~nothing, keep original
}

// ─── Fast tweet filter — one cheap LLM call to drop garbage ──
//
// Purpose: between xapi fetch and the 3-question analyzer, run tweets
// through a quick "useful vs noise" pass using the same cheap model.
// Regex filters (bot patterns, follower threshold) already happen in
// scan.ts; this catches the subtler noise they miss: pure shilling,
// unrelated multi-token spam, empty hype.
//
// Batched across ALL candidates in one request, so cost = 1 LLM call
// regardless of token/tweet count.

export interface TweetFilterInput {
  id: string;
  token_key?: string;       // "chain:address" — lets the model know which token the tweet belongs to
  symbol?: string;
  text: string;
  author?: string;
  followers?: number;
}

export interface TweetFilterVerdict {
  useful: boolean;
  reason?: string;
}

export async function filterUsefulTweets(
  items: TweetFilterInput[],
): Promise<Map<string, TweetFilterVerdict>> {
  const out = new Map<string, TweetFilterVerdict>();
  const llm = resolveInnerLlm();
  if (!llm.apiKey || items.length === 0) return out;

  const sections = items.map((t, i) =>
    `  [${i + 1}] id=${t.id} tok=${t.token_key ?? "?"} sym=${t.symbol ?? "?"} @${t.author ?? "?"}(${t.followers ?? 0}): ${String(t.text).slice(0, 220).replace(/\s+/g, " ")}`,
  ).join("\n");

  const prompt = [
    `你是加密 meme 币情报过滤器。下面是 ${items.length} 条推文，针对其所属代币的"值不值得分析"做判断。`,
    `严格要求：高粉账号≠有用。先看内容是否解释了"币是什么/为什么涨"，再考虑粉丝数。`,
    ``,
    `❌ 命中任一即 useful=false（噪音/喊单/广告类）：`,
    `  - 纯倍数喊单：内容主体是 "17x ✅" / "30x pump" / "21.34X 3h" / "$X K → $Y M" / "100x gem"`,
    `    （即使有 CA，只要解释信息几乎为零都算）`,
    `  - 多个连续 ✅ 或 🚀🚀🚀 或 💎💎 而文字内容寥寥`,
    `  - 私推/拉群广告：DM / TG fam / VIP / private group / 入群 / 跟单群 / 加入群 / 私聊 / discord`,
    `  - "我早喊过/早入过/早进车" 自吹型，不解释项目本身`,
    `  - 机器人格式：🐳 whale buy / top call 👉 / MC: $X holder Y 多代币并列`,
    `  - 与该代币无关：列一串别的币、广告、完全没提该代币`,
    `  - 无信息量：单词、纯 emoji、纯链接、\$TICKER 只是标签没有内容`,
    `  - 纯空投/presale/claim 推广`,
    ``,
    `✅ 保留（解释类，最有价值）：`,
    `  - 描述代币名称含义/出处/起源`,
    `  - 解释催化事件（"X 换头像了"/"X 公布了"/"今天发生了 X"/"事件：……"）`,
    `  - 提到具体人物/项目/作品关联`,
    `  - 创始人/发起者背景`,
    `  - 引用网络梗 / 文化梗的解读`,
    `  - 用"事件:" "起源:" "感受:" "深度:" "为什么:" "因为:" "由于:" 起头的解读型推文`,
    ``,
    `推文列表:`,
    sections,
    ``,
    `严格返回 JSON 数组，长度必须 = ${items.length}，每项 id 必须和输入一致，只输出 JSON：`,
    `[{"id":"xxx","useful":true},{"id":"yyy","useful":false},...]`,
  ].join("\n");

  try {
    const res = await fetch(llm.baseUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${llm.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "user", content: prompt }],
        // DeepSeek's reasoning_content eats budget too — pad heavily.
        max_tokens: Math.min(60 * items.length + 1_500, 8_000),
        temperature: 0,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      console.error(`[filter] HTTP ${res.status}`);
      return out;
    }
    const data: any = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return out;
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) {
      console.error(`[filter] no JSON array in response`);
      return out;
    }
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return out;
    for (const e of parsed) {
      if (!e?.id) continue;
      out.set(String(e.id), { useful: Boolean(e.useful), reason: e.reason });
    }
    const keptCount = Array.from(out.values()).filter((v) => v.useful).length;
    console.log(`[filter] ${keptCount}/${out.size} tweets kept (${items.length} in)`);
    return out;
  } catch (e: any) {
    console.error(`[filter] error:`, e?.message ?? e);
    return out;
  }
}

// ─── BATCH analyzer — all candidates in ONE LLM call ───────────

export interface BatchItem {
  key: string;              // unique id per token, e.g. "sol:F1pp..."
  facts: TokenFacts;
  disc: DiscussionInput;
  prior?: PriorAnalysis;
}

/**
 * Analyze many tokens in a single LLM call. Returns Map<key, ThreeAnswers>.
 * Slots with no material (no tweets + no web) are skipped client-side.
 * On any LLM/parse failure returns empty map — caller falls back to nulls.
 *
 * Why batch: rate-limit-friendly (1 req vs N), and the model sees the
 * full population so it can spot cross-candidate narrative overlap.
 */
export async function analyzeBatch(items: BatchItem[]): Promise<Map<string, ThreeAnswers>> {
  const out = new Map<string, ThreeAnswers>();
  const llm = resolveInnerLlm();
  if (!llm.apiKey) return out;

  const usable = items.filter(
    (it) => it.disc.tweet_snippets.length > 0 || it.disc.web_snippets.length > 0
  );
  if (usable.length === 0) return out;

  // Today's date in the analyzer's prompt — so the LLM can compute
  // "how many days ago" for each tweet/web entry and filter for
  // truly-recent catalysts (≤ 7 days) in recent_reason.
  const nowIso = new Date().toISOString().slice(0, 10);
  const ageLabel = (iso: string | undefined): string => {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!t) return "";
    const minutes = (Date.now() - t) / 60_000;
    if (minutes < 0) return "";
    if (minutes < 60) return `[${Math.round(minutes)}m ago]`;     // < 1h → minute precision
    const hours = minutes / 60;
    if (hours < 24) return `[${Math.round(hours)}h ago]`;
    const days = Math.round(hours / 24);
    return days <= 30 ? `[${days}d ago]` : `[${iso.slice(0, 10)}]`;
  };

  const sections = usable.map((it, i) => {
    // Quality-score sort, NOT just by follower count. Pure-shill tweets
    // from 100k+ accounts (e.g. "17x ✅✅✅") would otherwise crowd out
    // the actual gold — a 1k-follower 解读 post that explains why the
    // token exists. Scoring rewards explanatory content + length, and
    // penalizes hype patterns / DM-promotion / "X-倍" callouts.
    const HYPE_RX = /\d+\s*[xX×]\s*[✅🚀💎]|✅\s*✅|🚀\s*🚀|💎\s*💎|\bDM\b|\bVIP\b|\bTG\s*fam\b|私聊|拉群|入群|跟单群|early entry|secured profits/i;
    const EXPLAIN_RX = /事件\s*[:：]|起源\s*[:：]|感受\s*[:：]|为什么|由于|因为|是.*的(简称|缩写|名字|代名|代号)|来自|跟随|借势|借用|衍生|关联|换头像|换横幅|宣布|发推|爆料|公告|launched|announced|due to|because|inspired by|origin/i;
    const tweetQuality = (t: any): number => {
      const text = String(t.text ?? "");
      const len = text.length;
      let s = 0;
      if (len > 200) s += 4; else if (len > 100) s += 2; else if (len > 50) s += 1;
      if (EXPLAIN_RX.test(text)) s += 6;
      if (HYPE_RX.test(text)) s -= 6;
      // log-scaled follower bonus — meaningful but doesn't dominate
      const fol = Number(t.followers ?? 0);
      s += Math.log10(fol + 10);
      return s;
    };
    const sortedTweets = [...it.disc.tweet_snippets].sort((a, b) => tweetQuality(b) - tweetQuality(a));
    const tw = sortedTweets.slice(0, 15).map((t) => {
      const age = ageLabel(t.created_at);
      return `    - @${t.author ?? "?"} (${t.followers ?? 0} 粉)${age ? " " + age : ""}: ${String(t.text ?? "").slice(0, 180).replace(/\s+/g, " ")}`;
    }).join("\n");
    const web = it.disc.web_snippets.slice(0, 8).map((w) => {
      const age = ageLabel(w.date);
      const stamp = age || (w.date ? `[${w.date}]` : "");
      return `    - ${w.title}${stamp ? " " + stamp : ""}: ${String(w.snippet ?? "").slice(0, 160).replace(/\s+/g, " ")}`;
    }).join("\n");
    const priorStr = it.prior && (it.prior.what_is || it.prior.narrative_direction || it.prior.recent_reason)
      ? `  上次分析: ${it.prior.what_is ?? "-"} | ${it.prior.narrative_direction ?? "-"} | ${it.prior.recent_reason ?? "-"}`
      : "";
    // Project metadata — critical hints the LLM must try to decode
    const metaBits: string[] = [];
    if (it.facts.name && it.facts.name !== it.facts.symbol) metaBits.push(`name="${it.facts.name}"`);
    if (it.facts.twitter_handle) metaBits.push(`twitter=@${it.facts.twitter_handle}`);
    if (it.facts.website) metaBits.push(`website=${it.facts.website}`);
    if (it.facts.description) metaBits.push(`desc="${String(it.facts.description).slice(0, 200)}"`);
    const metaLine = metaBits.length > 0 ? `  meta: ${metaBits.join(" · ")}` : "";

    return [
      `### [${i + 1}] key=${it.key}`,
      `  facts: chain=${it.facts.chain} symbol=${it.facts.symbol ?? "?"} price=${it.facts.price ?? "?"} chg1h=${it.facts.chg1h ?? "?"}% chg24h=${it.facts.chg24h ?? "?"}% mcap=${it.facts.market_cap ?? "?"}`,
      metaLine,
      `  Twitter (${it.disc.tweet_snippets.length} 条):`,
      tw || "    (无)",
      `  Web (${it.disc.web_snippets.length} 条):`,
      web || "    (无)",
      priorStr,
    ].filter(Boolean).join("\n");
  }).join("\n\n");

  const prompt = [
    `你是加密 meme 币研究员。任务：把每个代币 反向追溯 到它真实的"催化源头"——`,
    `即"是谁/什么事件/什么文化梗，让这个币存在并被炒作的"。`,
    ``,
    `今天是 ${nowIso}。每条推文/网页后面的 [Xm ago] [Xh ago] [Xd ago] 标注是距今时间；输出 recent_reason 时也用相同精度（不到1h用"分钟前"，不要写"0小时前"）；`,
    `★ recent_reason 必须引用 7 天内 的事件/推文/新闻，不能用"长期炒作"或历史叙事糊弄。`,
    ``,
    `四个字段（核心问题：大家用什么在炒这个币？）：`,
    `  what_is             — 名称的实际含义/出处（人物? 事件? 梗? 项目?）[可以是长期稳定事实]`,
    `  narrative_direction — 叙事归属：挂靠在哪个名人/项目/事件/亚文化的大叙事下 [可以是长期稳定]`,
    `  recent_reason       — ★ 最近 7 天 大家用什么在炒这个币：哪个具体的人/事件/推文/新闻在驱动近期话题`,
    `                         必须挑选 ≤ 7 天的材料佐证，并在答案里点明时间（如"4/21 官方推文"/"2 天前"）`,
    `                         如果所有推文/网页都 > 7 天，老实写"近 7 天内未发现新催化（最近动态是 N 天前 XX）"`,
    `  catalyst_impact     — ★ 1-10 整数，催化事件影响力评分，综合两个维度：`,
    `                         (a) 事件本身的级别：人物地位/机构权重/文化覆盖`,
    `                         (b) 观察到的传播：高粉账号数/推文密度/跨语言扩散度`,
    `                         锚定：`,
    `                            10 = 国家元首/苹果 keynote/SCOTUS 涉 crypto 裁决`,
    `                          8-9 = 关键人物背书（X 平台高管换头像/L1 链创始人公开买入/马斯克回复某 meme 账号）`,
    `                          6-7 = 知名圈层联动（50-500k 粉 KOL 集体喊单/知名 VC 公开持仓/跟某热门事件）`,
    `                          4-5 = 常规催化（项目方主网公告/Binance Alpha 上线/中粉 KOL 个人持仓）`,
    `                          2-3 = 弱催化（小号喊单/社区群聊讨论）`,
    `                            1 = 没有可指的具体事件，纯投机`,
    `                         ★ 反作弊硬规则：`,
    `                         - 仅凭"名字暗指某名人/产品"（如 \$XCHAT 名字像马斯克 X 平台）但材料里没找到该名人/产品**最近 24h 内的相关推文/官方动作** → 最高 4 分`,
    `                         - 引用的 KOL 推文若超过 24h，影响力 -2`,
    `                         - 没有任何 ≥10K 粉账号的近期（24h 内）发推 → 最高 5 分`,
    `                         严格要求：你给的分数必须能从材料里找到对应等级的证据。无证据不给高分。`,
    ``,
    `=== ★ 涨因提取黄金法则（recent_reason 优先级） ===`,
    `按以下顺序检查推文/网页，找到第一个匹配的就是答案，必须直接引用原文细节：`,
    ``,
    `  优先级 1（★★★）— **高粉账号（>5k 粉）的"解释性"推文**：`,
    `      搜索关键词："因为"/"由于"/"换头像"/"换横幅"/"宣布"/"买入"/"原因是"/`,
    `                  "because"/"announced"/"due to"/"changed"/"bought"`,
    `      只要 1 条这种推文存在，那就是答案。把作者名 + 粉丝数 + 时间 + 原话片段 全塞到回答里。`,
    ``,
    `  优先级 2（★★）— **项目官号最新动态**：meta 行里的 twitter=@xxx`,
    `      官号本身的发推往往直接点明叙事/上线/合作`,
    ``,
    `  优先级 3（★★）— **知名人物钱包买入**：搜推文里的"鲸鱼地址"/"X 钱包买入"/`,
    `      "TOLY/Vitalik/CZ 等业内 OG bought"/"founder of X bought"`,
    ``,
    `  优先级 4（★）— **媒体文章标题/日期**：web 搜索里 title 含具体事件 + 日期`,
    ``,
    `=== 真实人物/产品/事件 必须具名，不要抽象化 ===`,
    `示例 A（个人 IP 衍生 meme，影响力 8）：`,
    `  what_is: "$BOAR 是 'Nikita Boar' 的简称，源自 X 平台产品负责人 Nikita Bier 的名字（其本人是 Solana Labs 顾问、Lightspeed 合伙人）"`,
    `  narrative_direction: "Nikita Bier 个人 IP × Solana 生态 meme，同期与 \\$NIKITA 联动"`,
    `  recent_reason: "@0xmoles（23k 粉，6h 前）爆料：Nikita Bier 把推特横幅换成 BOAR meme 项目头像；Solana 创始人 Toly 钱包 (HEa1...c1jD) 跟买"`,
    `  catalyst_impact: 8  // X 平台高管 + L1 创始人买入，关键人物级别`,
    ``,
    `示例 B（产品上线衍生，影响力 9）：`,
    `  what_is: "$xchat 是马斯克 X 平台即将上线的端到端加密聊天功能名"`,
    `  narrative_direction: "马斯克 X 生态 meme，与 xAI / Grok / X Money 同主题"`,
    `  recent_reason: "马斯克 4/22 推文公布 xChat beta 名单，@dogedesigner（180k 粉）同步转发，社区抢发币卡位"`,
    `  catalyst_impact: 9  // 马斯克本人推文 + 顶级 KOL 转发，影响范围全球`,
    ``,
    `示例 C（文化梗/IP 衍生，影响力 5）：`,
    `  what_is: "哈基米是日本动画《赛马娘》中角色 Hokko Tarumae 的中文音译昵称"`,
    `  narrative_direction: "日系赛马娘 IP 衍生 meme（与东海帝皇/特别周等同族）"`,
    `  recent_reason: "@xx_yy（12k 粉，3 天前）发推："NHK 重播赛马娘第三季"，国内 KOL 联动炒作"`,
    `  catalyst_impact: 5  // 中粉 KOL + 二次元 IP 重播，单语种圈层`,
    ``,
    `示例 D（项目方公告，影响力 5）：`,
    `  what_is: "$ASTEROID 是 Solana 链 meme 币 ASTEROID 项目代币"`,
    `  narrative_direction: "Solana 老牌 meme，社区驱动，跟随 SOL 生态情绪"`,
    `  recent_reason: "官方 4/24 推文宣布申请 Binance Alpha 上线，进入候选公示阶段"`,
    `  catalyst_impact: 5  // 上 Binance Alpha 是常规催化，不是顶级事件`,
    ``,
    `=== ❌ 禁止的废话答案 ===`,
    `禁止使用以下任何一类模板化空话（命中即视为不及格）：`,
    `  - "社区炒作" / "纯炒作" / "情绪驱动"`,
    `  - "BSC上的meme币" / "Base上的meme币" / "Solana meme 币" 等"链 + meme币"复述`,
    `  - "模因币炒作" / "Meme 币热度上升"`,
    `  - 空泛总结："XX项目相关讨论" / "XX话题活跃" / "XX交易活跃" / "XX相关炒作"`,
    `  - "X相关叙事" / "X相关代币" / "X项目叙事"（同义反复，没说清是 X 的什么叙事）`,
    `  - "相关新闻" / "相关事件" / "相关活动" / "相关消息"（用"相关"字掩盖内容为空）`,
    `  - "社区关注" / "市场关注" / "持续关注"（只是态度，没有内容）`,
    `  - **如果提到"新闻/事件/推文"，必须在答案里塞一段 10-30 字的原文引用（可以是推文 snippet 或网页 title 里的原话），否则视为编造**`,
    `  - "材料不足" 单独作答（必须改为"材料不足，未发现明确催化（疑似 X 或 Y）"或具体说明缺什么）`,
    `  - 复述价格涨跌幅当作 reason（"-3.41%跌幅，无具体原因" 这种零信息答案）`,
    ``,
    `=== recent_reason 必须具体到以下至少一项 ===`,
    `  ✅ 具体事件："XX 交易所 4/20 官宣上线 XX 合约"`,
    `  ✅ 具体人物："@某 KOL（50 万粉）在推文 X 中提到该币是 XX 的衍生"`,
    `  ✅ 具体产品动作："官方推特宣布 4/21 开启 XX 空投/质押/新功能"`,
    `  ✅ 具体文化/事件关联："近期某节日/比赛/电影上映让相关梗火起来"`,
    `  ❌ 反例：填"SoSoValue 项目相关讨论和交易活跃" — 没说是什么讨论、谁在讨论、活跃在哪`,
    `  ✅ 正例：填"官方 @SoSoValue 4/19 推文发布新产品 XX，Chinese KOL 转发带动讨论"`,
    ``,
    `=== 反向追溯方法（按顺序过一遍） ===`,
    `1. ★ symbol 字面含义：`,
    `   - 拆成词素（中文：单字/词组；英文：首字母缩写？组合词？）`,
    `   - 匹配到什么？人名/项目缩写/网络梗/影视角色/动物拟人/政治术语/地名/商品/文化术语`,
    `   - 例："共建" → 建设相关；BNB = Build aNd Build，该交易所创始人书中核心理念`,
    `   - 例："兔星星" → 中国航天吉祥物；"哈基米" → 日本动画角色音译`,
    `2. ★ 元数据线索（meta 行）：`,
    `   - twitter=@xxx：官方账号名本身常直接点明叙事（如 @xchat_meme）`,
    `   - website=xxx.yyy：域名关键词是叙事源头（如 buildnbuild.io 指向 CZ 理念）`,
    `   - name 和 symbol 不一致时，name 往往是完整英文解释（如 name="Community Build" symbol="共建"）`,
    `3. tweet 内容聚焦："反复出现的人名/平台/事件/词组" = 催化源`,
    `4. web 结果标题日期：锁定时间（最近新闻？长期文化？）和来源（官媒？KOL？论坛？）`,
    `5. 即使材料稀薄，也要推测并标 "(推测)" — 绝不写"社区炒作"草草了事`,
    `6. 如果以上都查不到，把你怀疑的方向写出来，至少说明"疑似关联 X/Y，需继续观察"`,
    ``,
    sections,
    ``,
    `严格返回 JSON 数组，长度必须 = ${usable.length}，每项 key 必须和输入一致：`,
    `[`,
    `  {"key":"xxx","what_is":"...","narrative_direction":"...","recent_reason":"...","catalyst_impact":8},`,
    `  ...`,
    `]`,
    ``,
    `输出规则:`,
    `- 每个字段 30–100 中文字符`,
    `- 禁止编造材料没提到的事实；如果是推测，必须以"(推测)"结尾`,
    `- 只输出 JSON 数组，不加任何解释或 markdown 包装`,
    `- 如果有上次分析，基于它增量更新；如果上次分析仍然是模板答案（含"社区炒作"等禁词），必须重新做`,
  ].join("\n");

  try {
    const res = await fetch(llm.baseUrl, {
      method: "POST",
      headers: { "Authorization": `Bearer ${llm.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "user", content: prompt }],
        // DeepSeek V4 emits reasoning_content tokens that count against
        // max_tokens, so a tight per-item budget gets eaten by the
        // chain-of-thought before any JSON can be emitted. V4-Flash
        // pricing is 2¥/M output tokens — generous budgets are cheap.
        // 600/item answer + 4K reasoning overhead, capped at 32K (still
        // far below the model's 384K output ceiling).
        max_tokens: Math.min(600 * usable.length + 4_000, 32_000),
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`[analyzer/batch] HTTP ${res.status}: ${errText.slice(0, 500)}`);
      return out;
    }
    const data: any = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return out;
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) {
      console.error(`[analyzer/batch] no JSON array found in response. raw[0..600]:\n${raw.slice(0, 600)}`);
      return out;
    }
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return out;
    const clean = (s: any) => String(s ?? "").slice(0, 200).trim();
    const clampImpact = (v: any): number => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 5;     // missing/garbage → neutral
      return Math.max(1, Math.min(10, Math.round(n)));
    };
    for (const entry of parsed) {
      if (!entry?.key) continue;
      const answers: ThreeAnswers = {
        what_is: stripFillerTail(clean(entry.what_is)),
        narrative_direction: stripFillerTail(clean(entry.narrative_direction)),
        recent_reason: stripFillerTail(clean(entry.recent_reason)),
        catalyst_impact: clampImpact(entry.catalyst_impact),
      };
      if (answers.what_is || answers.narrative_direction || answers.recent_reason) {
        out.set(String(entry.key), answers);
      }
    }
    console.log(`[analyzer/batch] ${out.size}/${usable.length} items analyzed in 1 LLM call`);
    return out;
  } catch (e: any) {
    console.error(`[analyzer/batch] error:`, e?.message ?? e);
    return out;
  }
}

/** Call cheap LLM and parse JSON. Returns null on any failure. */
export async function analyzeThreeQuestions(
  facts: TokenFacts,
  disc: DiscussionInput,
  prior?: PriorAnalysis,
): Promise<ThreeAnswers | null> {
  const llm = resolveInnerLlm();
  if (!llm.apiKey) return null;
  if (disc.tweet_snippets.length === 0 && disc.web_snippets.length === 0) return null;

  const prompt = buildPrompt(facts, disc, prior);

  try {
    const res = await fetch(llm.baseUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${llm.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: llm.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 400,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.error(`[analyzer] HTTP ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") return null;

    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const clean = (s: any) => String(s ?? "").slice(0, 200).trim();
    const impact = Number(parsed.catalyst_impact);
    const out: ThreeAnswers = {
      what_is: clean(parsed.what_is),
      narrative_direction: clean(parsed.narrative_direction),
      recent_reason: clean(parsed.recent_reason),
      catalyst_impact: Number.isFinite(impact) ? Math.max(1, Math.min(10, Math.round(impact))) : 5,
    };
    if (!out.what_is && !out.narrative_direction && !out.recent_reason) return null;
    return out;
  } catch (e: any) {
    console.error(`[analyzer] error:`, e?.message ?? e);
    return null;
  }
}
