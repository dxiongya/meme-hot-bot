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
 *   3. KEY_ENTITY — does the surrounding chatter mention high-impact
 *      entities (AI giants, Musk, US govt, central banks, top-10
 *      crypto figures)?
 *
 * If a token has WEAK first-pass narrative ("未发现新催化") but ALL
 * THREE enrichment checks pass, we promote it back into the premium
 * candidate set and use the search hits as the catalyst story.
 *
 * Result is persisted on premium_signals.enrichment so the reflector
 * can later correlate enrichment signals with outcome success.
 */
import { xapiTwitterSearch, xapiWebSearch, type TwitterSearchTweet, type WebSearchHit } from "../../lib/xapi.js";
import type { PremiumCandidate } from "./filter.js";

// Names + variants of the entities we care about. Lowercased before match.
const KEY_ENTITY_PATTERNS: Record<string, RegExp> = {
  musk:       /\b(elon|musk|@elonmusk)\b/i,
  trump:      /\b(trump|@realdonaldtrump|@potus)\b/i,
  us_gov:     /\b(white\s*house|sec\b|treasury|cftc|fed\b|congress|whitehouse\.gov)\b/i,
  ai_giants:  /\b(openai|anthropic|claude|gpt-?\d|gemini|google\s*ai|deepmind|xai|grok)\b/i,
  binance:    /\b(binance|cz\b|@cz_binance)\b/i,
  // Avoid "ETH" / "SOL" — they're chain names and false-positive every token.
  vitalik:    /\b(vitalik|@vitalikbuterin)\b/i,
};

const HIGH_INFLUENCE_FOLLOWERS = 10_000;
const RECENT_TWEET_HOURS = 48;
const RECENT_WEB_DAYS = 7;

export interface EnrichmentResult {
  is_recent: boolean;
  is_influential: boolean;
  key_entities: string[];           // labels of matched entity groups
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

function detectEntities(text: string): string[] {
  const hits: string[] = [];
  for (const [label, rx] of Object.entries(KEY_ENTITY_PATTERNS)) {
    if (rx.test(text)) hits.push(label);
  }
  return hits;
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

  // 3. key entities — scan tweet bodies + web titles+snippets
  const corpus =
    recentTweets.map((t) => t.text ?? "").join("\n") +
    "\n" +
    webHits.map((h) => `${h.title} ${h.snippet ?? ""}`).join("\n");
  const key_entities = detectEntities(corpus);

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
