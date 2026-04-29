/**
 * Pure functions for meme scan analytics. All inputs explicit, no side
 * effects. These are the "algorithms" the user asked for:
 *   - 异动指数 anomalyScore + anomalyDelta
 *   - 讨论量 discussionCount (author-follower-weighted)
 *   - 热度值 heatScore (time-decayed)
 */

// ─── 异动指数 ─────────────────────────────────────────────────

/**
 * Score how anomalous a token's recent price action is.
 * Higher = more anomalous. Normalizes across timeframes so a huge 5m
 * move and a sustained 24h run both score well.
 */
export function anomalyScore(input: {
  chg1h?: number | null;
  chg24h?: number | null;        // accepted but not used; kept for back-compat call sites
  chg5m?: number | null;
  volume_ratio?: number | null;
}): number {
  const { chg1h, chg5m, volume_ratio } = input;
  const a1h = Math.abs(Number(chg1h ?? 0));
  const a5m = Math.abs(Number(chg5m ?? 0));
  // Short-window only — we want "pumping NOW" signals.
  // 5m gets 3x weight so fresh 5-min spikes beat slow 1h grinds.
  const priceScore = Math.max(a1h, a5m * 3);
  const volScore = Math.min(Number(volume_ratio ?? 0), 10);
  return priceScore + volScore;
}

export interface HistoryPoint {
  ts: string;                // ISO
  chg1h?: number | null;
  chg24h?: number | null;
  chg5m?: number | null;
  score: number;
}

/**
 * "Still pumping" gate.
 *
 * Two ways to qualify:
 *   (a) chg1h ≥ +25%  — sustained hourly pump
 *   (b) chg5m ≥ +8%  AND chg1h ≥ -5%  — fresh 5-min pump where the
 *       hour isn't deeply negative. The hour-floor rules out
 *       post-crash dead-cat bounces (e.g. UNICURVE chg1h=-31% with
 *       chg5m=+34% = relief rebound, not "still pumping").
 *
 * Crashes never qualify regardless of abs-magnitude.
 */
const STILL_PUMPING_CHG1H = 25;
const STILL_PUMPING_CHG5M = 8;
const STILL_PUMPING_CHG1H_FLOOR = -5;     // chg1h floor when only 5m is the trigger

/**
 * Compare current anomaly score to last recorded point. Returns the
 * raw delta and a `continuing_up` flag.
 *
 * `continuing_up` fires when EITHER:
 *   (a) the score has risen on the last 2+ observations (accelerating),
 *       OR
 *   (b) the latest directional change is positive AND large
 *       (chg1h > +25% OR chg5m > +8%). DIRECTION matters — a -14%
 *       chg5m crash with high abs-anomaly does NOT qualify.
 */
export function anomalyDelta(
  history: HistoryPoint[],
  currentScore: number,
  currentChg?: { chg1h?: number | null; chg5m?: number | null },
): {
  delta: number;
  pct_delta: number;
  continuing_up: boolean;
  is_spiking: boolean;
} {
  const c1 = Number(currentChg?.chg1h ?? 0);
  const c5 = Number(currentChg?.chg5m ?? 0);
  const stillPumping =
    c1 >= STILL_PUMPING_CHG1H ||
    (c5 >= STILL_PUMPING_CHG5M && c1 >= STILL_PUMPING_CHG1H_FLOOR);

  if (history.length === 0) {
    return { delta: 0, pct_delta: 0, continuing_up: stillPumping, is_spiking: false };
  }
  const prev = history[history.length - 1];
  const delta = currentScore - prev.score;
  const pct_delta = prev.score > 0 ? delta / prev.score : (currentScore > 0 ? Infinity : 0);

  // Rising-streak must be DIRECTIONAL (signed chg1h trend, not abs
  // score). The anomalyScore is abs-magnitude — when a token crashes
  // harder each scan, score climbs even though chg1h is going more
  // negative (LUCA -29% → -42% → -43% has rising abs-score but is
  // actually accelerating downward). Compare signed chg1h instead.
  let rising_streak = 0;
  let lastCompare = c1;          // signed chg1h, not abs score
  for (let i = history.length - 1; i >= 0; i--) {
    const prevChg = Number(history[i].chg1h ?? 0);
    if (lastCompare > prevChg) rising_streak++;
    else break;
    lastCompare = prevChg;
  }
  // rising_streak alone isn't enough — the signed chg1h might be
  // climbing but still negative (e.g. LOKI -34% → -20% → -7%: trend
  // improving but still in a downtrend). Require the latest chg1h to
  // have actually crossed into positive territory.
  const trendUpAndPositive = rising_streak >= 2 && c1 >= 0;

  return {
    delta,
    pct_delta,
    continuing_up: trendUpAndPositive || stillPumping,
    is_spiking: pct_delta >= 0.5,
  };
}

// ─── 讨论量 ─────────────────────────────────────────────────

export interface TweetLike {
  screen_name?: string;
  followers?: number;
  favorite_count?: number;
  reply_count?: number;
  retweet_count?: number;
  quote_count?: number;
  created_at_ms?: number | null;
}

/**
 * Weighted discussion count. A single tweet from a 50k-follower account
 * with real engagement should count way more than a 150-follower alt
 * posting the CA in isolation.
 *   raw_engagement = favorite + reply + retweet + quote
 *   follower_weight = log10(followers + 10)   # 100=2, 1000=3, 10k=4, 100k=5
 *   score += (raw_engagement + 1) * follower_weight
 */
export function discussionCount(tweets: TweetLike[]): {
  total: number;
  unique_authors: number;
  breakdown: Array<{ screen_name: string | undefined; contribution: number }>;
} {
  const perAuthor = new Map<string, number>();
  const breakdown: Array<{ screen_name: string | undefined; contribution: number }> = [];
  let total = 0;
  for (const t of tweets) {
    const engagement = (Number(t.favorite_count) || 0)
                     + (Number(t.reply_count) || 0)
                     + (Number(t.retweet_count) || 0)
                     + (Number(t.quote_count) || 0);
    const followers = Number(t.followers) || 0;
    const follower_weight = Math.log10(followers + 10);
    const contribution = (engagement + 1) * follower_weight;
    total += contribution;
    breakdown.push({ screen_name: t.screen_name, contribution });
    if (t.screen_name) {
      perAuthor.set(t.screen_name, (perAuthor.get(t.screen_name) ?? 0) + contribution);
    }
  }
  return {
    total: Math.round(total * 100) / 100,
    unique_authors: perAuthor.size,
    breakdown,
  };
}

// ─── 热度值 (时间衰退) ─────────────────────────────────────

/**
 * Decay factor by tweet age in hours.
 *   < 24h   → 1.0    (最新鲜)
 *   24-72h  → 0.7
 *   72-168h → 0.3
 *   > 168h  → 0.1
 */
export function decayByAge(age_hours: number): number {
  if (age_hours < 24) return 1.0;
  if (age_hours < 72) return 0.7;
  if (age_hours < 168) return 0.3;
  return 0.1;
}

/**
 * Compute a single heat_score for a token from a bag of tweets.
 * heat_score = Σ (engagement_weighted × follower_weight × decay(age))
 * Newer & higher-engagement & higher-follower tweets contribute
 * exponentially more.
 */
export function heatScore(tweets: TweetLike[], nowMs: number = Date.now()): number {
  let heat = 0;
  for (const t of tweets) {
    const engagement = (Number(t.favorite_count) || 0)
                     + (Number(t.reply_count) || 0)
                     + (Number(t.retweet_count) || 0)
                     + (Number(t.quote_count) || 0);
    const follower_weight = Math.log10((Number(t.followers) || 0) + 10);
    const age_ms = t.created_at_ms ? (nowMs - t.created_at_ms) : 0;
    const age_hours = age_ms / 3_600_000;
    const decay = age_hours >= 0 ? decayByAge(age_hours) : 1.0;
    heat += (engagement + 1) * follower_weight * decay;
  }
  return Math.round(heat * 100) / 100;
}

/**
 * Re-decay a previously-computed heat_score given how much time has
 * passed since it was recorded. Used when we pull an existing
 * token_analyses row and want the "current" heat before adding new
 * tweets' contribution.
 */
export function decayStoredHeat(prevHeat: number, prevRecordedAtMs: number, nowMs: number = Date.now()): number {
  const age_hours = (nowMs - prevRecordedAtMs) / 3_600_000;
  if (age_hours < 0) return prevHeat;
  return prevHeat * decayByAge(age_hours);
}

// ─── Star rating ───────────────────────────────────────────

export interface StarInput {
  heatScore: number;
  discussionCount: number;
  anomalyContinuingUp: boolean;
  isKnownToken: boolean;        // true if token_analyses already had a row
}

/**
 * 0-3 stars.
 *   ⭐⭐⭐ — 已分析过 且 异动持续上升（continuing_up）+ 高热度
 *   ⭐⭐   — 高热度 OR 异动持续上升（单条件）
 *   ⭐     — 有讨论（discussion_count > 0）
 *   空     — 其它
 */
export function starRating(i: StarInput): number {
  const hot = i.heatScore >= 500;
  const hasDisc = i.discussionCount >= 10;
  if (i.isKnownToken && i.anomalyContinuingUp && hot) return 3;
  if (hot || (i.isKnownToken && i.anomalyContinuingUp)) return 2;
  if (hasDisc) return 1;
  return 0;
}
