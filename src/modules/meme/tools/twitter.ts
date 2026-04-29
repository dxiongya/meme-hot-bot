import { Type } from "@sinclair/typebox";
import { defineJsonTool } from "../../../lib/tool-helpers.js";
import { execJson } from "../../../lib/exec.js";
import { readPage } from "../../../lib/brain/reader.js";

/**
 * Anti-bot filter patterns — accumulated from observed false positives.
 * Each class catches a different kind of social-manipulation spam.
 */
const PATTERNS = {
  // Generic ad / hype spam
  genericAd: /(\bbuy now\b|🚀🚀🚀|100x gem|gem alert|airdrop claim|click link|join.+telegram|presale.+now|dm for signals|limited time|don't miss|pump incoming)/i,

  // Whale-alert bots — the "🐳 Whale Buy" pattern with buy amount + CA
  whaleAlert: /🐳.*buy|whale\s*[->→]\s*buy|🚨.*whale|smart\s*money.*buy\s*[->→]|whale\s*alert/i,

  // "Top call" / "Smart-money call" signal channel bots
  signalChannel: /top\s*call\s*👉|personalized trading|copy trades|alpha telegram|my vip group|my alpha.+group|printed.+profits|massive profits|secured a massive|locking an incredible|printing inside my/i,

  // Past-win shill — greatly broadened. ANY multiplier followed by call/return/gem/profit/win/gain, OR "did it Nx" / "I gave you <ticker> at Y" / "Did you miss my Nx"
  shillPastWin:
    /did\s*it\s*[\d.,]+\s*x|made\s*it\s*[\d.,]+\s*x|[\d.,]+\s*x\s*(?:call|return|gem|profit|gain|win|move|pump)|did\s*you\s*miss\s*my\s*[\d.,]+\s*x|now\s*i\s*give\s*you|i\s*gave\s*you[^.]{0,40}at|still\s*(?:grinding|all-?in|holding)\s*\$\w+|still\s*\$\w+\s*(?:strong|holding)|\bentry\s*at\s*\$?[\d,.]+[kmb]?\s*[→\-]+\s*(?:now|sitting|at)/i,

  // Special unicode look-alikes used to evade plain-ASCII filters
  unicodeCA: /ᴄᴀ\s*[:：]|ᴛᴏᴋᴇɴ\s*[:：]|ᴍᴄ\s*[:：]|ʜᴏʟᴅᴇʀ|𝘛oken\s*[:：]/i,

  // Tweet structured like a whale bot template: "MC: $50K" + "Holder: 1435"
  botTemplate: /(?:mc|market\s*cap|ᴍᴄ|mcp)\s*[:：]?\s*\$?\d+[km]?[\s\S]{0,40}?(?:holder|ʜᴏʟᴅᴇʀ|hodler)/i,

  // 3+ cash tags = ticker-spray shill
  cashTagSpam: /\$[A-Z0-9]{2,12}.*\$[A-Z0-9]{2,12}.*\$[A-Z0-9]{2,12}/,

  // Live-stream gimmick promo (buybacks per viewer, dev-on-live drama)
  livePromo: /buybacks?\s*\d+\s*sol\s*at\s*a\s*time|dev\s*(?:doing|on)\s*(?:buyback|live)|every\s*\d+\s*viewers?\s*on\s*live|live\s*stream\s*buyback/i,
};

function emojiRatio(s: string): number {
  // Rough emoji density — high ratio implies shill / bot template.
  const emojis = s.match(/\p{Extended_Pictographic}/gu) ?? [];
  return emojis.length / Math.max(1, s.length);
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 200);
}

/** Load brain bot watchlist — one screen_name per line (prefixed with "- "). */
async function loadBotWatchlist(): Promise<Set<string>> {
  const page = await readPage("meme/log/bots.md").catch(() => null);
  if (!page) return new Set();
  const names = new Set<string>();
  for (const line of page.content.split(/\r?\n/)) {
    const m = line.match(/^-\s*@?([A-Za-z0-9_]+)/);
    if (m) names.add(m[1].toLowerCase());
  }
  return names;
}

async function searchOnce(query: string, sort: "Top" | "Latest") {
  try {
    return await execJson<{ success: boolean; data?: { tweets: unknown[] }; error?: unknown }>(
      "npx",
      ["-y", "xapi-to", "call", "twitter.search", "--input", JSON.stringify({ raw_query: query, sort_by: sort })],
      { timeoutMs: 30_000 }
    );
  } catch (e) {
    return { success: false, error: String(e) } as const;
  }
}

export const twitterSearchTool = defineJsonTool({
  name: "twitter_search",
  label: "twitter search",
  description:
    "Search Twitter for a token. Searches $SYMBOL + bare SYMBOL + CA (first 12 chars) in parallel, merges by tweet_id, applies the 10-layer bot filter AND a time-window filter (default last 3 days — current heat only, not lifetime). Pass contract_address for highest-confidence organic signal. Returns legit count, ca_hits, top_voices, rejected breakdown incl. too_old.",
  parameters: Type.Object({
    query: Type.String({ description: "Token symbol WITHOUT $ prefix (e.g. 'ASTEROID')" }),
    contract_address: Type.Optional(Type.String({
      description: "Full token contract address. Strongly recommended — tweets mentioning the CA are overwhelmingly organic. First 12 chars used for the search.",
    })),
    sort_by: Type.Optional(
      Type.Union([Type.Literal("Top"), Type.Literal("Latest")], { default: "Latest" })
    ),
    max_age_days: Type.Optional(
      Type.Number({ default: 3, minimum: 1, maximum: 90, description: "Only keep tweets created within the last N days. Defaults to 3 — we only care about current discussion heat, not historical noise." })
    ),
  }),
  run: async ({ query, contract_address, sort_by, max_age_days }) => {
    const sort = sort_by ?? "Latest";
    const maxAgeDays = max_age_days ?? 3;
    const botList = await loadBotWatchlist();

    // Compose 3 queries in parallel:
    //   1) $SYMBOL  (cashtag — gets discussion from traders who use the convention)
    //   2) bare SYMBOL  (catches the rest — especially for tokens without popular cashtag)
    //   3) CA first 12 chars  (goldmine: bots almost never paste the CA)
    const qSymbol = `$${query}`;
    const qBare = query;
    const caSlice = contract_address?.slice(0, 12);

    const results = await Promise.all([
      searchOnce(qSymbol, sort),
      searchOnce(qBare, sort),
      caSlice ? searchOnce(caSlice, sort) : Promise.resolve({ success: true, data: { tweets: [] as unknown[] } }),
    ]);

    const symTweets = (results[0].success && "data" in results[0]) ? (results[0] as any).data.tweets ?? [] : [];
    const bareTweets = (results[1].success && "data" in results[1]) ? (results[1] as any).data.tweets ?? [] : [];
    const caTweets = (results[2].success && "data" in results[2]) ? (results[2] as any).data.tweets ?? [] : [];

    // Merge by tweet_id. Track source so we know which query matched.
    const byId = new Map<string, any>();
    for (const t of symTweets)  if (t?.tweet_id) byId.set(t.tweet_id, { ...t, _sources: ["cashtag"] });
    for (const t of bareTweets) {
      const id = t?.tweet_id;
      if (!id) continue;
      if (byId.has(id)) byId.get(id)._sources.push("bare");
      else byId.set(id, { ...t, _sources: ["bare"] });
    }
    for (const t of caTweets) {
      const id = t?.tweet_id;
      if (!id) continue;
      if (byId.has(id)) byId.get(id)._sources.push("ca");
      else byId.set(id, { ...t, _sources: ["ca"] });
    }
    const merged: any[] = [...byId.values()];

    const now = Date.now();
    const seen = new Map<string, number>();
    const rejectStats = {
      blacklisted_bot: 0,
      low_followers: 0,
      follow_ratio: 0,
      high_frequency: 0,
      young_account: 0,
      blue_check_spam: 0,
      whale_alert: 0,
      signal_channel: 0,
      shill_past_win: 0,
      unicode_ca: 0,
      bot_template: 0,
      cashtag_spam: 0,
      live_promo: 0,
      emoji_heavy: 0,
      ad_generic: 0,
      too_short: 0,
      duplicate: 0,
      too_old: 0,
    };

    // Parse tweet timestamp — xapi-to may expose it as `created_at`,
    // `timestamp`, `tweet_created_at` or similar. Try a few; if none are
    // readable, treat the tweet as fresh (fail-open) so a schema drift
    // doesn't silently wipe all results.
    const ageCutoffMs = Date.now() - maxAgeDays * 86_400_000;
    const tweetTimeMs = (t: any): number | null => {
      const c = t?.created_at ?? t?.tweet_created_at ?? t?.timestamp ?? t?.created_at_ms;
      if (c == null) return null;
      if (typeof c === "number") return c < 1e12 ? c * 1000 : c;
      const n = Date.parse(String(c));
      return Number.isFinite(n) ? n : null;
    };

    const legit = merged.filter((t) => {
      const u = t?.user ?? {};
      const screen = String(u.screen_name ?? "").toLowerCase();
      const followers = Number(u.followers_count ?? 0);
      const following = Number(u.friends_count ?? 0);
      const statuses = Number(u.statuses_count ?? 0);
      const verified = !!u.verified;
      const created = u.created_at ? new Date(u.created_at).getTime() : 0;
      const age_days = created ? (now - created) / 86_400_000 : 0;
      const text: string = t?.text ?? "";

      // Time-window filter (3-day default) — only current-heat discussion counts.
      const ttMs = tweetTimeMs(t);
      if (ttMs !== null && ttMs < ageCutoffMs) { rejectStats.too_old++; return false; }

      // Brain blacklist (highest priority)
      if (botList.has(screen)) { rejectStats.blacklisted_bot++; return false; }

      // Account-level rejects — Twitter Blue commoditized `verified`, so NEVER trust it alone.
      // Minimum 800 followers required regardless of verified status.
      if (followers < 800) { rejectStats.low_followers++; return false; }
      // Blue-check spam: verified but few followers + few statuses = paid checkmark from nobody
      if (verified && followers < 3000 && statuses < 5000) { rejectStats.blue_check_spam++; return false; }
      if (followers > 0 && following / followers > 10) { rejectStats.follow_ratio++; return false; }
      if (age_days > 0 && statuses / age_days > 50) { rejectStats.high_frequency++; return false; }
      if (age_days > 0 && age_days < 7) { rejectStats.young_account++; return false; }

      // Content-level rejects (order matters — most specific first)
      if (PATTERNS.whaleAlert.test(text)) { rejectStats.whale_alert++; return false; }
      if (PATTERNS.signalChannel.test(text)) { rejectStats.signal_channel++; return false; }
      if (PATTERNS.shillPastWin.test(text)) { rejectStats.shill_past_win++; return false; }
      if (PATTERNS.livePromo.test(text)) { rejectStats.live_promo++; return false; }
      if (PATTERNS.unicodeCA.test(text)) { rejectStats.unicode_ca++; return false; }
      if (PATTERNS.botTemplate.test(text)) { rejectStats.bot_template++; return false; }
      if (PATTERNS.cashTagSpam.test(text)) { rejectStats.cashtag_spam++; return false; }
      if (emojiRatio(text) > 0.20) { rejectStats.emoji_heavy++; return false; }
      if (PATTERNS.genericAd.test(text)) { rejectStats.ad_generic++; return false; }
      if (text.length < 30) { rejectStats.too_short++; return false; }

      // Copy-paste dedup
      const norm = normalize(text);
      if ((seen.get(norm) ?? 0) >= 1) { rejectStats.duplicate++; return false; }
      seen.set(norm, (seen.get(norm) ?? 0) + 1);

      return true;
    });

    // Separate CA-hit tweets (much higher confidence of organic discussion)
    const caHits = legit.filter((t) => t._sources?.includes("ca"));

    // Suspicious screen_names that appear LEGIT this round but also shill-template —
    // surface to agent for potential bot-watchlist addition.
    const suspicious: string[] = [];
    for (const t of merged) {
      const screen = String(t?.user?.screen_name ?? "").toLowerCase();
      if (!screen || botList.has(screen)) continue;
      const text: string = t?.text ?? "";
      if (
        PATTERNS.whaleAlert.test(text) ||
        PATTERNS.signalChannel.test(text) ||
        PATTERNS.botTemplate.test(text) ||
        PATTERNS.unicodeCA.test(text)
      ) {
        suspicious.push(screen);
      }
    }

    return {
      ok: true,
      queries: { symbol: qSymbol, bare: qBare, ca: caSlice ?? null },
      max_age_days: maxAgeDays,
      total_raw: merged.length,
      legit: legit.length,
      ca_hits: caHits.length,             // organic tweets that mention the CA directly
      uniq_users: Array.from(new Set(legit.map((t) => t.user?.screen_name))).length,
      rejected: rejectStats,
      total_likes: legit.reduce((s, t) => s + Number(t?.favorite_count ?? 0), 0),
      total_views: legit.reduce((s, t) => s + Number(t?.view_count ?? 0), 0),
      top_voices: legit
        .slice()
        .sort((a, b) => Number(b?.user?.followers_count ?? 0) - Number(a?.user?.followers_count ?? 0))
        .slice(0, 5)
        .map((t) => ({
          screen_name: t?.user?.screen_name,
          followers: t?.user?.followers_count,
          verified: t?.user?.verified,
          account_age_days: t?.user?.created_at ? Math.floor((now - new Date(t.user.created_at).getTime()) / 86_400_000) : null,
          text: String(t?.text ?? "").slice(0, 240),
          likes: t?.favorite_count,
          views: t?.view_count,
          source: t._sources?.join(",") ?? "symbol",   // "ca" means tweet contains the CA
        })),
      suspicious_bot_candidates: Array.from(new Set(suspicious)).slice(0, 10),
    };
  },
});

export const twitterTools = [twitterSearchTool];
