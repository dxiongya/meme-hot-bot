import { Type } from "@sinclair/typebox";
import { defineJsonTool } from "../../../lib/tool-helpers.js";
import {
  searchMemeBrain,
  getMemeTokenPage,
  listMemeStarredTokens,
  updateTokenEntity,
  writeScanPage,
  writePatternPage,
  appendDecision,
  appendBotWatchlist,
} from "../brain-scope.js";

export const brainSearchTool = defineJsonTool({
  name: "brain_search",
  label: "brain search",
  description:
    "Full-text search the meme-module brain across token entities, patterns, scans, and decisions.",
  parameters: Type.Object({
    query: Type.String(),
    type: Type.Optional(
      Type.Union([
        Type.Literal("token"),
        Type.Literal("pattern"),
        Type.Literal("scan"),
        Type.Literal("decision"),
      ])
    ),
    limit: Type.Number({ minimum: 1, maximum: 50, default: 10 }),
  }),
  run: ({ query, type, limit }) => searchMemeBrain(query, { type, limit }),
});

export const brainReadTokenPageTool = defineJsonTool({
  name: "brain_read_token_page",
  label: "brain read token",
  description: "Read the meme brain entity page for one specific token (chain + address).",
  parameters: Type.Object({
    chain: Type.String(),
    address: Type.String(),
  }),
  run: async ({ chain, address }) =>
    (await getMemeTokenPage(chain, address)) ?? { exists: false, chain, address },
});

export const brainListStarredTool = defineJsonTool({
  name: "brain_list_starred",
  label: "brain list starred",
  description: "Meme tokens that have appeared in 2+ scan reports and are not banned.",
  parameters: Type.Object({
    limit: Type.Number({ minimum: 1, maximum: 100, default: 50 }),
  }),
  run: ({ limit }) => listMemeStarredTokens(limit),
});

export const brainUpdateTokenTool = defineJsonTool({
  name: "brain_update_token",
  label: "brain update token",
  description:
    "Rewrite the compiled-truth section of a meme token entity page and append one new timeline event.",
  parameters: Type.Object({
    chain: Type.String(),
    address: Type.String(),
    symbol: Type.Optional(Type.String()),
    new_compiled_truth: Type.String(),
    timeline_event: Type.String(),
    verdict: Type.Optional(
      Type.String({
        description:
          "Short verdict tag. Recommended values: bullish | neutral | bearish | scam | banned | watch | pump | fading. Free-form allowed.",
      })
    ),
    score: Type.Optional(Type.Number()),
    sources: Type.Optional(Type.Array(Type.String())),
  }),
  run: async (args) => {
    const path = await updateTokenEntity({
      chain: args.chain,
      address: args.address,
      symbol: args.symbol,
      newCompiledTruth: args.new_compiled_truth,
      timelineEvent: args.timeline_event,
      frontmatterPatch: {
        ...(args.verdict ? { verdict: args.verdict } : {}),
        ...(args.score !== undefined ? { score: args.score } : {}),
        ...(args.sources ? { sources: args.sources } : {}),
      },
    });
    return { written: path };
  },
});

export const brainWriteScanTool = defineJsonTool({
  name: "brain_write_scan",
  label: "brain write scan",
  description:
    "Write an immutable meme scan snapshot page. Path: meme/scans/YYYY-MM-DD/HHMM.md.",
  parameters: Type.Object({
    summary_markdown: Type.String(),
    chains: Type.Array(Type.String()),
    candidates_count: Type.Number(),
    top5_per_chain: Type.Optional(Type.Any()),
    top10_overall: Type.Optional(Type.Any()),
  }),
  run: async (args) => {
    const path = await writeScanPage({
      summaryMarkdown: args.summary_markdown,
      chains: args.chains,
      candidatesCount: args.candidates_count,
      top5PerChain: args.top5_per_chain,
      top10Overall: args.top10_overall,
    });
    return { written: path };
  },
});

export const brainAppendDecisionTool = defineJsonTool({
  name: "brain_append_decision",
  label: "brain append decision",
  description: "Append one timestamped line to meme/log/decisions.md.",
  parameters: Type.Object({ line: Type.String() }),
  run: async ({ line }) => {
    await appendDecision(line);
    return { ok: true };
  },
});

export const brainWritePatternTool = defineJsonTool({
  name: "brain_write_pattern",
  label: "brain write pattern",
  description: "Create or replace a meme pattern wiki page under meme/patterns/<slug>.md.",
  parameters: Type.Object({
    slug: Type.String(),
    title: Type.String(),
    summary_markdown: Type.String(),
  }),
  run: async ({ slug, title, summary_markdown }) => {
    const path = await writePatternPage({ slug, title, summaryMarkdown: summary_markdown });
    return { written: path };
  },
});

export const brainAppendBotTool = defineJsonTool({
  name: "brain_append_bot",
  label: "brain append bot",
  description:
    "Add a suspicious Twitter screen_name to the meme bot watchlist (meme/log/bots.md). Subsequent twitter_search calls will auto-filter these accounts out. Use when you see the same account repeatedly shilling across different tokens.",
  parameters: Type.Object({
    screen_name: Type.String({ description: "Twitter screen_name WITHOUT @, lowercase" }),
    note: Type.String({ description: "One-line reason, e.g. 'whale-alert bot template', 'pump TG shill'" }),
  }),
  run: async ({ screen_name, note }) => {
    await appendBotWatchlist(screen_name, note);
    return { ok: true, added: screen_name };
  },
});

export const brainTools = [
  brainSearchTool,
  brainReadTokenPageTool,
  brainListStarredTool,
  brainUpdateTokenTool,
  brainWriteScanTool,
  brainAppendDecisionTool,
  brainWritePatternTool,
  brainAppendBotTool,
];
