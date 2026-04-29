/**
 * Meme-module brain scope. Wraps the shared brain lib with path prefixes + entity semantics
 * specific to on-chain meme tokens (tokens/{chain}/{address}.md).
 */
import {
  updateEntityPage,
  writePage,
  appendLogLine,
} from "../../lib/brain/writer.js";
import {
  searchBrain as sharedSearch,
  getEntityPage as sharedGetEntity,
  listStarredPages,
  listLatestScanRuns,
} from "../../lib/brain/search.js";

export const SCOPE = "meme";

// ----- paths -----
export const tokenPath = (chain: string, address: string) =>
  `${SCOPE}/tokens/${chain}/${address}.md`;
export const patternPath = (slug: string) => `${SCOPE}/patterns/${slug}.md`;
export const decisionsLogPath = `${SCOPE}/log/decisions.md`;

export function scanPath(now = new Date()): string {
  const dd = now.toISOString().slice(0, 10);
  const hhmm = now.toISOString().slice(11, 16).replace(":", "");
  return `${SCOPE}/scans/${dd}/${hhmm}.md`;
}

// ----- entity writers -----
export async function updateTokenEntity(opts: {
  chain: string;
  address: string;
  symbol?: string;
  newCompiledTruth: string;
  timelineEvent: string;
  frontmatterPatch?: Record<string, unknown>;
}): Promise<string> {
  const path = tokenPath(opts.chain, opts.address);
  await updateEntityPage({
    path,
    type: "token",
    newCompiledTruth: opts.newCompiledTruth,
    timelineEvent: opts.timelineEvent,
    frontmatterPatch: {
      chain: opts.chain,
      address: opts.address,
      symbol: opts.symbol,
      ...(opts.frontmatterPatch ?? {}),
    },
  });
  return path;
}

export async function writeScanPage(opts: {
  summaryMarkdown: string;
  chains: string[];
  candidatesCount: number;
  top5PerChain?: unknown;
  top10Overall?: unknown;
}): Promise<string> {
  const path = scanPath();
  await writePage({
    path,
    type: "scan",
    frontmatter: {
      scope: SCOPE,
      ts: new Date().toISOString(),
      chains: opts.chains,
      candidates_count: opts.candidatesCount,
      top5_per_chain: opts.top5PerChain,
      top10_overall: opts.top10Overall,
    },
    content: opts.summaryMarkdown,
  });
  return path;
}

export async function writePatternPage(opts: {
  slug: string;
  title: string;
  summaryMarkdown: string;
}): Promise<string> {
  const path = patternPath(opts.slug);
  await writePage({
    path,
    type: "pattern",
    frontmatter: {
      scope: SCOPE,
      title: opts.title,
      slug: opts.slug,
      updated: new Date().toISOString(),
    },
    content: opts.summaryMarkdown,
  });
  return path;
}

export async function appendDecision(line: string): Promise<void> {
  return appendLogLine(decisionsLogPath, line);
}

/** Bot screen-name watchlist (meme/log/bots.md). Twitter filter reads this. */
export const botsWatchlistPath = `${SCOPE}/log/bots.md`;
export async function appendBotWatchlist(screenName: string, note: string): Promise<void> {
  const line = `- @${screenName} — ${note}`;
  return appendLogLine(botsWatchlistPath, line);
}

// ----- readers (scope-pinned) -----
export const searchMemeBrain = (q: string, opts?: { type?: string; limit?: number }) =>
  sharedSearch(q, { scope: SCOPE, ...opts });

export const getMemeTokenPage = (chain: string, address: string) =>
  sharedGetEntity({ scope: SCOPE, kind: "token", id1: chain, id2: address });

export const listMemeStarredTokens = (limit = 50) => listStarredPages(SCOPE, limit);

export const listMemeLatestScans = (limit = 20) => listLatestScanRuns(SCOPE, limit);
