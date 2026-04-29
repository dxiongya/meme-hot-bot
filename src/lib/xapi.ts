/**
 * xapi-to direct-HTTP helpers. Replaces spawning `npx -y xapi-to` for
 * every call (which added ~2s startup overhead per call).
 *
 * Endpoint: POST https://action.xapi.to/v1/actions/execute
 * Auth:     XAPI-Key header
 * Proxy:    inherits global undici dispatcher (see src/lib/proxy-env.ts)
 */

const XAPI_URL = "https://action.xapi.to/v1/actions/execute";

function getKey(): string | null {
  return process.env.XAPI_API_KEY || null;
}

async function execute<T = any>(
  action_id: string,
  input: Record<string, any>,
  timeoutMs = 10_000,
): Promise<T | null> {
  const key = getKey();
  if (!key) {
    console.error(`[xapi] XAPI_API_KEY not set — skip ${action_id}`);
    return null;
  }
  try {
    const res = await fetch(XAPI_URL, {
      method: "POST",
      headers: { "XAPI-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ action_id, input }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[xapi ${action_id}] HTTP ${res.status}: ${text.slice(0, 200)}`);
      return null;
    }
    const body: any = await res.json();
    if (body?.success === false) {
      console.error(`[xapi ${action_id}] business error:`, JSON.stringify(body).slice(0, 200));
      return null;
    }
    return body as T;
  } catch (e: any) {
    console.error(`[xapi ${action_id}] fetch:`, e?.message ?? e);
    return null;
  }
}

// ─── twitter.search ────────────────────────────────────────

export interface TwitterSearchTweet {
  tweet_id?: string;
  id?: string;
  text?: string;
  created_at?: string;
  favorite_count?: number;
  reply_count?: number;
  retweet_count?: number;
  quote_count?: number;
  view_count?: number;
  user?: {
    screen_name?: string;
    name?: string;
    followers_count?: number;
    friends_count?: number;
    statuses_count?: number;
    verified?: boolean;
    created_at?: string;
  };
}

export async function xapiTwitterSearch(
  query: string,
  sortBy: "Top" | "Latest" = "Latest",
): Promise<TwitterSearchTweet[]> {
  const res = await execute<{ data?: { tweets?: TwitterSearchTweet[] } }>(
    "twitter.search",
    { raw_query: query, sort_by: sortBy },
    8_000,
  );
  return res?.data?.tweets ?? [];
}

// ─── web.search (Google) ───────────────────────────────────

export interface WebSearchHit {
  title: string;
  link: string;
  snippet?: string;
  date?: string;
  position?: number;
}

export async function xapiWebSearch(query: string): Promise<WebSearchHit[]> {
  const res = await execute<{ data?: { organic?: WebSearchHit[] } }>(
    "web.search",
    { q: query },
    12_000,
  );
  return res?.data?.organic ?? [];
}

/**
 * Combined search for a meme token. Always searches CA + web for the
 * symbol. Returns hit counts + raw content for downstream analysis.
 */
export async function searchTokenDiscussion(params: {
  chain: string;
  address: string;
  symbol?: string;
}): Promise<{
  twitter_hits: TwitterSearchTweet[];
  web_hits: WebSearchHit[];
  has_any_discussion: boolean;
}> {
  const { chain, address, symbol } = params;
  const twitterQ = address;  // full CA — we verified this is what gets indexed
  const webQ = symbol
    ? `${symbol} ${chain} crypto ${address.slice(0, 8)}`
    : `${chain} ${address}`;

  const [twitter_hits, web_hits] = await Promise.all([
    xapiTwitterSearch(twitterQ),
    xapiWebSearch(webQ),
  ]);
  return {
    twitter_hits,
    web_hits,
    has_any_discussion: twitter_hits.length > 0 || web_hits.length > 0,
  };
}

// ─── ave trending (eth) ────────────────────────────────────

export async function xapiAveTrending(chain: string, pageSize: number): Promise<any[]> {
  // Ave's response nests twice: { success, data: { status, msg, data: { tokens: [...] } } }
  // execute() returns the outer body, so we have to step down .data.data.tokens.
  // Keep the old .data.tokens path as a back-compat fallback in case the API
  // format ever flattens.
  const res = await execute<any>(
    "ave.v2_tokens_trending",
    { method: "GET", params: { chain, page_size: pageSize } },
    15_000,
  );
  return res?.data?.data?.tokens ?? res?.data?.tokens ?? [];
}
