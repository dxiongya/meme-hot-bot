import { Agent } from "@mariozechner/pi-agent-core";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { config } from "../../../config.js";
import { resolveScanModel, resolveFastModel, resolveChatModel } from "../../../lib/llm-models.js";
import { gmgnTools } from "../tools/gmgn.js";
import { aveTools } from "../tools/ave.js";
import { memeScanTools } from "../tools/scan.js";
import {
  brainSearchTool,
  brainReadTokenPageTool,
  brainListStarredTool,
  brainWriteScanTool,
  brainTools,
} from "../tools/brain.js";
import { SCAN_SYSTEM_PROMPT } from "./prompts/scan.js";
import { CHAT_SYSTEM_PROMPT } from "./prompts/chat.js";
import { FAST_SCAN_SYSTEM_PROMPT } from "./prompts/scan-fast.js";

/** Full tool set — used for chat / manual debugging; scan agent uses `scanTools` */
const allTools: AgentTool<any, any>[] = [
  ...gmgnTools,
  ...aveTools,
  ...memeScanTools,
  ...brainTools,
];

/**
 * SCAN tool set — absolute minimum: one data tool + one report tool.
 * meme_scan does EVERYTHING inside (fetch, filter, xapi twitter+web,
 * AI three-question analysis, heat/discussion math, token_analyses
 * persistence). Main LLM only narrates and writes brain_write_scan.
 */
const scanTools: AgentTool<any, any>[] = [
  ...memeScanTools,          // the workhorse
  brainWriteScanTool,        // mandatory final step
];

/** Trimmed tool set for fast scan — core data + brain_write_scan only */
const fastTools: AgentTool<any, any>[] = [
  ...gmgnTools,
  brainListStarredTool,
  brainSearchTool,
  brainReadTokenPageTool,
  brainWriteScanTool,
];

export function createScanAgent(systemPromptOverride?: string) {
  const systemPrompt = (systemPromptOverride ?? SCAN_SYSTEM_PROMPT)
    .replace("{{chains}}", config.scan.chains.join(", "));
  return new Agent({
    initialState: {
      systemPrompt,
      model: resolveScanModel(),
      tools: scanTools,             // ← minimal, not allTools
    },
    getApiKey: (provider: string) => config.llm.getApiKey(provider),
    toolExecution: "parallel",
  });
}

export function createFastScanAgent(systemPromptOverride?: string) {
  const systemPrompt = (systemPromptOverride ?? FAST_SCAN_SYSTEM_PROMPT)
    .replace("{{chains}}", config.scan.chains.join(", "));
  return new Agent({
    initialState: {
      systemPrompt,
      model: resolveFastModel(),
      tools: fastTools,
    },
    getApiKey: (provider: string) => config.llm.getApiKey(provider),
    toolExecution: "parallel",
  });
}

export function createChatAgent(systemPromptOverride?: string) {
  return new Agent({
    initialState: {
      systemPrompt: systemPromptOverride ?? CHAT_SYSTEM_PROMPT,
      model: resolveChatModel(),
      tools: allTools,
    },
    getApiKey: (provider: string) => config.llm.getApiKey(provider),
    toolExecution: "parallel",
  });
}

export const allAgentTools = allTools;
