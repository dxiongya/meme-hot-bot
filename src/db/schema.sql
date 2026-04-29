-- pgvector for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================
-- pages: every brain markdown file is a row
-- =============================================================
CREATE TABLE IF NOT EXISTS pages (
  path TEXT PRIMARY KEY,                  -- e.g. tokens/sol/F1pp...bCP2.md
  type TEXT NOT NULL,                     -- token | pattern | scan | decision | meta
  frontmatter JSONB NOT NULL DEFAULT '{}',
  content TEXT NOT NULL DEFAULT '',
  fts tsvector,
  embedding vector(1536),                 -- pluggable; null until first embed
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pages_fts_gin ON pages USING GIN (fts);
CREATE INDEX IF NOT EXISTS pages_emb_hnsw
  ON pages USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS pages_chain_addr
  ON pages ((frontmatter ->> 'chain'), (frontmatter ->> 'address'));
CREATE INDEX IF NOT EXISTS pages_type ON pages (type);

-- =============================================================
-- scan_runs: one row per scheduled or manual scan
-- =============================================================
CREATE TABLE IF NOT EXISTS scan_runs (
  id UUID PRIMARY KEY,
  scope TEXT NOT NULL DEFAULT 'meme',  -- meme | futures — partition scans by service line
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  duration_ms INTEGER,
  chains TEXT[] NOT NULL,
  candidates_count INTEGER,
  top5_per_chain JSONB,
  top10_overall JSONB,
  summary TEXT,
  scan_page_path TEXT REFERENCES pages(path) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'running' -- running | done | failed
);
CREATE INDEX IF NOT EXISTS scan_runs_ts    ON scan_runs (ts DESC);
CREATE INDEX IF NOT EXISTS scan_runs_scope ON scan_runs (scope, ts DESC);

-- =============================================================
-- inbound_price_log: every time the Telegram inbound bot looks up
-- a CA, snapshot price/mcap so the next lookup can show "since
-- last query, X went +Y%". Rolling history per address.
-- =============================================================
CREATE TABLE IF NOT EXISTS inbound_price_log (
  id BIGSERIAL PRIMARY KEY,
  ca TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price NUMERIC,
  mcap NUMERIC
);
CREATE INDEX IF NOT EXISTS idx_inbound_price_log_ca_ts ON inbound_price_log (ca, ts DESC);

-- =============================================================
-- chat sessions + messages
-- =============================================================
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  title TEXT,
  agent_state JSONB
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY,
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                     -- user | assistant | tool_result | system
  content TEXT,
  tool_calls JSONB,
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS chat_messages_session_ts
  ON chat_messages (session_id, ts);

-- =============================================================
-- positions: virtual (paper-trading) positions opened off scan suggestions
-- =============================================================
CREATE TABLE IF NOT EXISTS positions (
  id UUID PRIMARY KEY,
  scan_id UUID REFERENCES scan_runs(id) ON DELETE SET NULL,
  symbol TEXT NOT NULL,                  -- e.g. RAVEUSDT
  direction TEXT NOT NULL,               -- LONG | SHORT
  setup TEXT,                            -- "Setup 1 顺势" / "Setup 2 反向"
  entry_price NUMERIC NOT NULL,          -- 开仓时的市价 (非 LLM 建议区间)
  sl_price NUMERIC NOT NULL,
  t1_price NUMERIC NOT NULL,
  t2_price NUMERIC NOT NULL,
  leverage NUMERIC NOT NULL,
  stake_usd NUMERIC NOT NULL DEFAULT 100,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'open',   -- open | sl_hit | t1_hit | t2_hit | manual_close | expired
  closed_at TIMESTAMPTZ,
  close_price NUMERIC,
  pnl_usd NUMERIC,
  pnl_pct NUMERIC,                       -- price move %, not leveraged
  rationale TEXT,                        -- one-line reason copied from scan
  notes TEXT
);
CREATE INDEX IF NOT EXISTS positions_status_opened ON positions (status, opened_at DESC);
CREATE INDEX IF NOT EXISTS positions_symbol ON positions (symbol);
CREATE INDEX IF NOT EXISTS positions_scan ON positions (scan_id);

-- =============================================================
-- symbol_snapshots: per-symbol extracted state at each scan
-- Stored so future scans only need the delta, not full tool returns
-- =============================================================
CREATE TABLE IF NOT EXISTS symbol_snapshots (
  id BIGSERIAL PRIMARY KEY,
  scope TEXT NOT NULL,                   -- meme | futures
  scan_id UUID,                          -- REFERENCES scan_runs(id) would be ideal but scan_id can be null for polls
  symbol TEXT NOT NULL,                  -- e.g. RAVEUSDT or ASTEROID
  chain TEXT,                            -- sol | base | bsc | eth | null for futures
  address TEXT,                          -- contract address (meme) or null
  ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  price NUMERIC,
  chg1h NUMERIC,
  chg24h NUMERIC,
  mcap NUMERIC,
  liquidity NUMERIC,
  oi_ratio NUMERIC,                      -- futures only
  funding NUMERIC,                       -- futures only
  square_en_count INTEGER DEFAULT 0,
  square_zh_count INTEGER DEFAULT 0,
  tw_legit_count INTEGER DEFAULT 0,
  ca_hits INTEGER DEFAULT 0,
  sentiment_direction TEXT,              -- bull | bear | neutral | sparse
  narrative TEXT,                        -- cheap-LLM-generated 1-line summary
  raw_digest JSONB,                      -- compact key fields LLM may need
  extra JSONB                            -- overflow / tool-specific
);
CREATE INDEX IF NOT EXISTS snapshots_scope_symbol_ts
  ON symbol_snapshots (scope, symbol, ts DESC);
CREATE INDEX IF NOT EXISTS snapshots_ts ON symbol_snapshots (ts DESC);

-- =============================================================
-- token_analyses: per-token persistent analysis state for meme scan
-- Keyed by (chain, address). Every scan either UPDATE an existing
-- row (incremental analysis) or INSERT a fresh one (three-question
-- analysis). Tweet summaries + bot watchlist tables retired in
-- favor of this single source of truth.
-- =============================================================
DROP TABLE IF EXISTS tweet_summaries;
DROP TABLE IF EXISTS bot_observations;

CREATE TABLE IF NOT EXISTS token_analyses (
  chain TEXT NOT NULL,
  address TEXT NOT NULL,
  symbol TEXT,
  name TEXT,

  -- Three-question analysis (AI-generated, persisted, supplemented over time)
  narrative_what_is     TEXT,           -- 这是一个什么币
  narrative_direction   TEXT,           -- 叙事方向
  recent_reason         TEXT,           -- 近期涨的原因

  -- Computed metrics
  discussion_count      NUMERIC DEFAULT 0,   -- weighted by author followers + engagement
  heat_score            NUMERIC DEFAULT 0,   -- time-decayed: 1d fresh, >1d decays

  -- Anomaly tracking (how the price/volume 异动 changed over time)
  latest_anomaly_score  NUMERIC,             -- most recent computed score
  anomaly_history       JSONB NOT NULL DEFAULT '[]'::jsonb,
                                             -- array of {ts, chg1h, chg24h, chg5m, score}
  last_price            NUMERIC,
  last_market_cap       NUMERIC,
  last_liquidity        NUMERIC,

  -- Three-strikes-no-discussion rule
  no_discussion_strikes INT NOT NULL DEFAULT 0,
  passed                BOOLEAN NOT NULL DEFAULT false,

  -- Processed tweets (avoid re-analyzing)
  processed_tweet_ids   TEXT[] NOT NULL DEFAULT '{}',

  -- Timestamps
  first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_analyzed_at      TIMESTAMPTZ,
  analyzed_count        INT NOT NULL DEFAULT 0,

  PRIMARY KEY (chain, address)
);
CREATE INDEX IF NOT EXISTS ta_heat  ON token_analyses (heat_score DESC) WHERE passed = false;
CREATE INDEX IF NOT EXISTS ta_chain ON token_analyses (chain, heat_score DESC) WHERE passed = false;
CREATE INDEX IF NOT EXISTS ta_anom  ON token_analyses (latest_anomaly_score DESC) WHERE passed = false;

-- =============================================================
-- copycat_pushes: cooldown state for cross-chain copycat groups.
-- Same group (e.g. PEPE on eth+bsc+sol) keeps showing up scan after
-- scan and clutters Telegram. We push the FIRST occurrence in full,
-- then mute re-pushes for COPYCAT_COOLDOWN_HOURS unless something
-- material changed (new chain joined / smart-money grew / chg1h
-- doubled — see scan.ts copycatPushGate).
-- =============================================================
CREATE TABLE IF NOT EXISTS copycat_pushes (
  key                TEXT PRIMARY KEY,             -- normalizeTokenKey output (symbol-normalized)
  display_name       TEXT,
  chains_sig         TEXT NOT NULL,                -- sorted unique chains, e.g. "base,eth,sol"
  max_smart_buys     INT NOT NULL DEFAULT 0,       -- max(smart+kol) across members at last push
  max_chg1h          NUMERIC NOT NULL DEFAULT 0,   -- max chg1h across members at last push
  members_count      INT NOT NULL DEFAULT 0,
  last_push_reason   TEXT,                         -- "first_push" | "new_chain" | "smart_grew" | "chg1h_doubled" | "cooldown_expired"
  last_pushed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  push_count         INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS copycat_pushes_last ON copycat_pushes (last_pushed_at DESC);
