/**
 * xapi-based external enrichment.
 *
 * For each premium candidate, do a quick web+twitter search to answer
 * three orthogonal questions:
 *
 *   1. RECENCY    — is the underlying event from the last 24-48h?
 *      (Old narratives don't drive new pumps.)
 *   2. INFLUENCE  — is there real-world reach? Heuristics:
 *                     - any tweet with ≥10K-follower author within 24h
 *                     - any web hit dated within 7d
 *                     - cumulative tweet count
 *   3. KEY_ENTITY — does the search corpus show MEANINGFUL connections
 *      to high-impact themes (AI / Musk / Trump / US-politics)? Judged
 *      by the LLM, NOT by regex — past versions tagged GOBLIN with
 *      "musk" because someone's bio mentioned perfume musk. Regex
 *      can't tell semantic relevance from incidental keyword overlap.
 *
 * If a token has WEAK first-pass narrative ("未发现新催化") but ALL
 * THREE enrichment checks pass, we promote it back into the premium
 * candidate set and use the search hits as the catalyst story.
 *
 * Result is persisted on premium_signals.enrichment so the reflector
 * can later correlate enrichment signals with outcome success.
 */
import { xapiTwitterSearch, xapiWebSearch, type TwitterSearchTweet, type WebSearchHit } from "../../lib/xapi.js";
import { config } from "../../config.js";
import type { PremiumCandidate } from "./filter.js";

const ENTITY_LABELS = ["ai", "musk", "trump", "us_politics"] as const;
type EntityLabel = (typeof ENTITY_LABELS)[number];

const ENTITY_DESCRIPTIONS: Record<EntityLabel, string> = {
  ai:          "AI 行业（OpenAI/Anthropic/xAI/DeepMind/Grok/Claude/GPT 等公司或产品；AI agent、模型、AGI、机器人主题）",
  musk:        "Elon Musk 本人或其旗下产品/公司（Tesla、SpaceX、X/Twitter、xAI、Neuralink、StarLink）",
  trump:       "Donald Trump 本人或其家族 / 直接相关的项目（World Liberty Financial、Trump 系列代币、个人发推）",
  us_politics: "美国政治/监管/政府机构（白宫、SEC、CFTC、Treasury、Fed、国会、大选议题、立法事件）",
};

const HIGH_INFLUENCE_FOLLOWERS = 10_000;
const RECENT_TWEET_HOURS = 48;
const RECENT_WEB_DAYS = 7;

export interface EnrichmentResult {
  is_recent: boolean;
  is_influential: boolean;
  key_entities: string[];           // labels of matched entity groups
  /** Per-entity provenance — first matching snippet for each label.
   *  Lets the monitor render "🏷 musk: @kol said …" instead of a bare
   *  tag the user can't verify. */
  entity_evidence: Record<string, { source: "tweet" | "web"; text: string; ref?: string }>;
  /** True iff ALL three (recent, influential, key_entity) hold. */
  all_three: boolean;
  /** Free-form 1-2 sentence summary the renderer can show in the card. */
  summary: string;
  evidence: {
    recent_tweet_count: number;
    high_follower_tweet: { screen_name: string; followers: number; text: string; created_at?: string } | null;
    recent_web_count: number;
    top_web_hit: { title: string; link: string; date?: string } | null;
  };
}

function tweetTsMs(t: TwitterSearchTweet): number | null {
  const ts = (t as any).timestamp ?? (t as any).created_at_ms ?? (t as any).created_at;
  if (!ts) return null;
  if (typeof ts === "number") return ts < 1e12 ? ts * 1000 : ts;
  const parsed = Date.parse(ts);
  return isNaN(parsed) ? null : parsed;
}

function withinRecentHours(t: TwitterSearchTweet, hours: number): boolean {
  const ms = tweetTsMs(t);
  if (!ms) return false;
  return Date.now() - ms <= hours * 3_600_000;
}

function webHitWithinDays(hit: WebSearchHit, days: number): boolean {
  if (!hit.date) return false;
  const parsed = Date.parse(hit.date);
  if (isNaN(parsed)) return false;
  return Date.now() - parsed <= days * 86_400_000;
}

interface EntityJudgment {
  connected: boolean;       // LLM-judged: is this theme MEANINGFULLY part of the token's narrative?
  evidence?: string;        // 1-sentence quote from the corpus that justifies it
  source?: "tweet" | "web";
  ref?: string;
}

/**
 * Ask the LLM whether the token has MEANINGFUL connections to AI /
 * Musk / Trump / US-politics. The previous regex version tagged
 * GOBLIN with "musk" because someone's tweet bio mentioned musk
 * perfume — keyword overlap, not narrative relevance. The LLM
 * understands that "this token sucks compared to Musk's X" is a
 * dismissive comparison, not a Musk endorsement.
 *
 * Cheap-model only (deepseek-v4-flash) — no reasoning needed, just
 * structured judgment over a few hundred tokens of context.
 */
async function judgeKeyConnectionsLLM(
  symbol: string,
  narrativeDirection: string | null,
  recentReason: string | null,
  tweets: TwitterSearchTweet[],
  webHits: WebSearchHit[],
): Promise<Record<EntityLabel, EntityJudgment>> {
  const empty: Record<EntityLabel, EntityJudgment> = {
    ai: { connected: false }, musk: { connected: false }, trump: { connected: false }, us_politics: { connected: false },
  };

  // Trim the corpus we send to the LLM — keep it tight.
  const tweetLines = tweets.slice(0, 12).map((t, i) => {
    const handle = t.user?.screen_name ?? "?";
    const followers = Math.round(Number(t.user?.followers_count ?? 0) / 1000);
    return `[T${i}] @${handle} (${followers}k 粉): ${(t.text ?? "").slice(0, 200)}`;
  }).join("\n");
  const webLines = webHits.slice(0, 6).map((h, i) =>
    `[W${i}] ${h.title}${h.date ? ` (${h.date})` : ""}: ${(h.snippet ?? "").slice(0, 180)}`,
  ).join("\n");

  if (!tweetLines && !webLines) return empty;

  const themeBlock = ENTITY_LABELS.map((k) => `  - ${k}: ${ENTITY_DESCRIPTIONS[k]}`).join("\n");

  const prompt = `判断 meme 币 \`$${symbol}\` 是否与下面 4 个主题"实质相关"——
相关 = 主题的人物/机构/产品确实是这个币叙事或近期上涨的核心驱动；
不相关 = 主题只是被顺带提及、调侃、对比、或者有人在自己 bio 里写到——这些 NOT 算相关。

主题列表：
${themeBlock}

---
币：$${symbol}
现有叙事：${narrativeDirection ?? "(无)"}
近期涨因：${recentReason ?? "(无)"}

最近的相关材料（@粉丝数 已标注）：
${tweetLines || "(无推文)"}

${webLines ? "网页搜索：\n" + webLines : ""}

---
严格输出 JSON，且只输出 JSON 对象，不要任何解释。键必须是 ai/musk/trump/us_politics。
每项都要给：
  "connected": true/false（实质相关 → true，否则 false）
  "evidence": 如果 connected=true，给一句话引用最有说服力的原文（截 80 字内）；connected=false 时省略

示例：
{"ai":{"connected":true,"evidence":"@VC_X (50k) 称 \\"$ABC is the first AI agent token to integrate with OpenAI's swarm\\""},"musk":{"connected":false},"trump":{"connected":false},"us_politics":{"connected":false}}`;

  try {
    const baseUrl = "https://api.deepseek.com/chat/completions";
    const apiKey = config.llm.getApiKey("deepseek");
    if (!apiKey) {
      console.warn("[premium enrich] no deepseek key — skipping LLM entity judgment");
      return empty;
    }
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: process.env.FAST_LLM_MODEL ?? "deepseek-v4-flash",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        max_tokens: 600,
        temperature: 0.1,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      console.warn(`[premium enrich] LLM judgment HTTP ${res.status}`);
      return empty;
    }
    const data: any = await res.json();
    const txt = data?.choices?.[0]?.message?.content ?? "";
    const parsed = JSON.parse(txt);

    const out: Record<EntityLabel, EntityJudgment> = { ...empty };
    for (const k of ENTITY_LABELS) {
      const v = parsed?.[k];
      if (v && typeof v === "object") {
        out[k] = {
          connected: !!v.connected,
          evidence: typeof v.evidence === "string" ? v.evidence : undefined,
        };
      }
    }
    return out;
  } catch (e) {
    console.warn(`[premium enrich] LLM judgment failed:`, e);
    return empty;
  }
}

/**
 * Run twitter + web search on the token symbol/name and judge the
 * three orthogonal signals. Single LLM-free pass — pure heuristics
 * over xapi results so we can run it on every candidate without
 * burning the LLM budget.
 */
export async function enrichCandidate(c: PremiumCandidate): Promise<EnrichmentResult> {
  const symbol = (c.symbol ?? "").trim();
  // Build queries. Use $SYMBOL for crypto context + plain symbol for breadth.
  const queries: string[] = [];
  if (symbol) {
    queries.push(`$${symbol}`);
    queries.push(symbol);
  }
  if (c.narrative_what_is) {
    // Pick the first 5-6 words for a topical query — captures named
    // entity references in narrative ("Matt Furie 新角色" → searchable).
    const topic = c.narrative_what_is.replace(/[^\p{L}\p{N}\s$@]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 6).join(" ");
    if (topic) queries.push(topic);
  }
  if (queries.length === 0) {
    return {
      is_recent: false,
      is_influential: false,
      key_entities: [],
      entity_evidence: {},
      all_three: false,
      summary: "no_query_seed",
      evidence: { recent_tweet_count: 0, high_follower_tweet: null, recent_web_count: 0, top_web_hit: null },
    };
  }

  // Twitter search — top query gets "Latest" so we see fresh velocity
  let tweets: TwitterSearchTweet[] = [];
  let webHits: WebSearchHit[] = [];
  try {
    tweets = await xapiTwitterSearch(queries[0], "Latest");
  } catch (e) { console.warn(`[premium enrich] twitter search failed for "${queries[0]}":`, e); }
  try {
    webHits = await xapiWebSearch(queries.slice(0, 2).join(" "));
  } catch (e) { console.warn(`[premium enrich] web search failed:`, e); }

  // 1. recency
  const recentTweets = tweets.filter((t) => withinRecentHours(t, RECENT_TWEET_HOURS));
  const recentWebHits = webHits.filter((h) => webHitWithinDays(h, RECENT_WEB_DAYS));
  const is_recent = recentTweets.length >= 3 || recentWebHits.length >= 1;

  // 2. influence — high-follower author within 48h is the cleanest tell
  const highFollowerTweet = recentTweets.find(
    (t) => Number(t.user?.followers_count ?? 0) >= HIGH_INFLUENCE_FOLLOWERS,
  ) ?? null;
  const is_influential = !!highFollowerTweet || recentTweets.length >= 10;

  // 3. key entities — LLM judges semantic relevance. The LLM sees the
  //    token's existing narrative + recent tweets/web hits and decides
  //    whether AI/Musk/Trump/US-politics are GENUINELY part of the
  //    story (not just keyword bleed-through).
  const judgments = await judgeKeyConnectionsLLM(
    symbol,
    c.narrative_direction,
    c.recent_reason,
    recentTweets.length > 0 ? recentTweets : tweets,
    webHits,
  );
  const key_entities = ENTITY_LABELS.filter((k) => judgments[k].connected);
  const entity_evidence: EnrichmentResult["entity_evidence"] = {};
  for (const k of key_entities) {
    const j = judgments[k];
    entity_evidence[k] = {
      source: "tweet",                              // LLM doesn't separate tweet/web in its evidence
      text: j.evidence ?? "(无引用)",
      ref: undefined,
    };
  }

  const all_three = is_recent && is_influential && key_entities.length > 0;

  const summary = (() => {
    const bits: string[] = [];
    if (is_recent) bits.push(`recent(${recentTweets.length}t/${recentWebHits.length}w)`);
    if (is_influential) {
      bits.push(highFollowerTweet
        ? `KOL@${highFollowerTweet.user?.screen_name ?? "?"}=${Math.round((highFollowerTweet.user?.followers_count ?? 0) / 1000)}k`
        : `vol_tweets=${recentTweets.length}`);
    }
    if (key_entities.length > 0) bits.push(`entities:${key_entities.join(",")}`);
    if (bits.length === 0) return "no_signal";
    return bits.join(" · ");
  })();

  const top_web_hit = recentWebHits[0]
    ? { title: recentWebHits[0].title, link: recentWebHits[0].link, date: recentWebHits[0].date }
    : null;

  return {
    is_recent,
    is_influential,
    key_entities,
    entity_evidence,
    all_three,
    summary,
    evidence: {
      recent_tweet_count: recentTweets.length,
      high_follower_tweet: highFollowerTweet
        ? {
            screen_name: highFollowerTweet.user?.screen_name ?? "?",
            followers: Number(highFollowerTweet.user?.followers_count ?? 0),
            text: (highFollowerTweet.text ?? "").slice(0, 300),
            created_at: (highFollowerTweet as any).created_at,
          }
        : null,
      recent_web_count: recentWebHits.length,
      top_web_hit,
    },
  };
}
