import { Type } from "@sinclair/typebox";
import { defineJsonTool } from "../../../lib/tool-helpers.js";
import { execJson } from "../../../lib/exec.js";

/**
 * All ave.* xapi actions wrap real HTTP calls to Ave cloud. The xapi-to spec
 * requires the outer envelope { method, params, path_params } — not a flat
 * body. Missing this returns 400 INVALID_INPUT.
 */
async function callXapiGet<T = unknown>(
  action: string,
  params: Record<string, unknown>,
  pathParams?: Record<string, unknown>,
): Promise<T> {
  const input: Record<string, unknown> = { method: "GET", params };
  if (pathParams) input.path_params = pathParams;
  return execJson<T>(
    "npx",
    ["-y", "xapi-to", "call", action, "--input", JSON.stringify(input)],
    { timeoutMs: 60_000 }
  );
}

export const aveTrendingTool = defineJsonTool({
  name: "ave_trending",
  label: "ave trending",
  description:
    "Trending tokens on a chain via Ave Cloud. Use this for ETH mainnet and any EVM chain gmgn doesn't cover (arbitrum, polygon, optimism…).",
  parameters: Type.Object({
    chain: Type.String({ description: "Chain id: eth, bsc, arbitrum, polygon, base, optimism, avalanche, fantom, etc." }),
    page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 30 })),
  }),
  run: ({ chain, page_size }) =>
    callXapiGet("ave.v2_tokens_trending", { chain, page_size: page_size ?? 30 }),
});

export const aveTokenInfoTool = defineJsonTool({
  name: "ave_token_info",
  label: "ave token info",
  description: "Token detail incl. price, liquidity, top 5 trading pairs, and basic risk via Ave Cloud.",
  parameters: Type.Object({
    token_id: Type.String({ description: "Format: <address>-<chain>, e.g. 0xabc...-eth" }),
  }),
  run: ({ token_id }) => callXapiGet("ave.v2_tokens_token-id", {}, { "token-id": token_id }),
});

export const aveTokenRiskTool = defineJsonTool({
  name: "ave_token_risk",
  label: "ave token risk",
  description:
    "Comprehensive contract risk info (honeypot, mint, blacklist, fee, ownership) for a token.",
  parameters: Type.Object({
    token_id: Type.String({ description: "Format: <address>-<chain>" }),
  }),
  run: ({ token_id }) => callXapiGet("ave.v2_contracts_token-id", {}, { "token-id": token_id }),
});

export const aveSmartWalletsTool = defineJsonTool({
  name: "ave_smart_wallets",
  label: "ave smart wallets",
  description: "Top smart wallets on a chain ranked by Ave's profitability scoring.",
  parameters: Type.Object({
    chain: Type.String(),
    page_size: Type.Optional(Type.Number({ minimum: 1, maximum: 100, default: 30 })),
  }),
  run: ({ chain, page_size }) =>
    callXapiGet("ave.v2_address_smart__wallet_list", { chain, page_size: page_size ?? 30 }),
});

export const aveTopHoldersTool = defineJsonTool({
  name: "ave_top_holders",
  label: "ave top holders",
  description: "Top 100 holders of a token; useful for concentration risk analysis.",
  parameters: Type.Object({
    token_id: Type.String({ description: "Format: <address>-<chain>" }),
  }),
  run: ({ token_id }) => callXapiGet("ave.v2_tokens_top100_token-id", {}, { "token-id": token_id }),
});

export const aveTools = [
  aveTrendingTool,
  aveTokenInfoTool,
  aveTokenRiskTool,
  aveSmartWalletsTool,
  aveTopHoldersTool,
];
