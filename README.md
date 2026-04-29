# crypto-radar-server

AI-driven multi-chain memecoin scanner. Pulls trending + smart-money + KOL signals across SOL/Base/BSC/ETH every 5 minutes, cross-references with Twitter discussion, and maintains a curated brain (markdown + Postgres) of token entities, patterns, and decisions.

## Stack

- **pi-ai** + **pi-agent-core** — agent runtime with tool calling
- **Hono** — HTTP router with SSE
- **Postgres + pgvector** — hybrid FTS + vector search over the brain
- **Markdown brain** — gbrain-style "compiled truth + timeline" pages

## Architecture

```
[5-min cron] → Agent.prompt(scan)
  → tool: gmgn_trending, ave_trending, twitter_search, brain_*
  → AI synthesizes Top 5 per chain + Top 10 overall
  → writes scans/ source page + updates token entity pages
  → SSE event for frontend
```

```
POST /api/chat (SSE) → Agent.prompt(userMsg)
  → tool: brain_search, brain_read_token_page
  → AI replies with citations
  → if directive (ban/rule/approve): writes log/decisions.md + updates entities
```

## Quick start

```bash
# 1. Postgres
docker compose up -d postgres

# 2. Env
cp .env.example .env
# edit .env: set XAPI_API_KEY, ANTHROPIC_API_KEY (or other LLM provider)

# 3. Install
npm install

# 4. Migrate
npm run migrate

# 5. Run
npm run dev

# 6. Trigger a manual scan
curl -X POST http://localhost:3000/api/jobs/scan-now

# 7. View latest scans
curl http://localhost:3000/api/scans

# 8. Chat (SSE)
curl -N http://localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"What did you find on SOL today?"}'
```

## Brain layout

```
brain/
  INDEX.md
  tokens/{sol,base,bsc,eth}/{address}.md   # entity (compiled truth + timeline)
  patterns/{slug}.md                        # learned market patterns
  scans/{YYYY-MM-DD}/{HHMM}.md              # immutable scan snapshots
  log/decisions.md                          # human-AI dialog outcomes
```

## Prerequisites

- gmgn-cli reachable via `HTTPS_PROXY` (we use SSH tunnel to a VPS, see `~/.config/gmgn/`)
- xapi-to CLI installed (`npx -y xapi-to`)
- Optionally: binance skills CLI
