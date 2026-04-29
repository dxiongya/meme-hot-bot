import { getModel } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";
import { config } from "../config.js";

/**
 * Build a GLM (智谱 open.bigmodel.cn) model via pi-ai's Custom Model shape.
 * GLM is OpenAI-compatible, so api = "openai-completions".
 * See: https://open.bigmodel.cn/dev/api
 */
function buildGlmModel(modelId: string): Model<"openai-completions"> {
  // Pricing is best-effort; usage accounting from API response overrides these.
  // Prices are CNY → USD approx at ~7.2 CNY/USD (as of 2026 Q1).
  const priceTable: Record<string, { input: number; output: number; ctx: number; max: number }> = {
    "glm-4-plus":       { input: 6.94,  output: 6.94,  ctx: 128_000, max: 16_000 },  // raise max_tokens so verbose reasoning_content doesn't starve tool calls
    "glm-4.5":          { input: 5.56,  output: 22.22, ctx: 128_000, max: 32_000 },  // glm-4.5 reasoning eats most of the budget; give it 32K
    "glm-5.1":          { input: 5.56,  output: 22.22, ctx: 128_000, max: 32_000 },  // reasoning model like 4.5; pricing placeholder until official rate
    "glm-4.5-air":      { input: 1.11,  output: 1.11,  ctx: 128_000, max: 16_000 },
    "glm-4.5-flash":    { input: 0.0,   output: 0.0,   ctx: 128_000, max: 16_000 },  // free tier
    "glm-4-air":        { input: 0.14,  output: 0.14,  ctx: 128_000, max: 16_000 },
    "glm-4-airx":       { input: 1.39,  output: 1.39,  ctx: 8_192,   max: 4_096 },
    "glm-4-long":       { input: 0.14,  output: 0.14,  ctx: 1_000_000, max: 16_000 },
    "glm-4-flash":      { input: 0.0,   output: 0.0,   ctx: 128_000, max: 16_000 },
    "glm-zero-preview": { input: 1.39,  output: 1.39,  ctx: 16_000,  max: 16_000 },
    "glm-4-alltools":   { input: 1.39,  output: 1.39,  ctx: 128_000, max: 16_000 },
  };
  const p = priceTable[modelId] ?? priceTable["glm-4-plus"];

  return {
    id: modelId,
    name: `${modelId} (GLM / 智谱)`,
    api: "openai-completions",
    provider: "glm",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    reasoning: modelId.includes("zero") || modelId.includes("thinking") || modelId === "glm-4.5" || modelId === "glm-5.1",
    input: ["text"],
    cost: { input: p.input, output: p.output, cacheRead: 0, cacheWrite: 0 },
    contextWindow: p.ctx,
    maxTokens: p.max,
    /**
     * GLM compatibility overrides — critical for tool calling to work via pi-ai.
     * Without these the agent loop silently fails (empty content, no tool_calls).
     * Verified against open.bigmodel.cn v4 endpoint:
     *   - no 'developer' role (only system/user/assistant)
     *   - no 'store' field
     *   - no 'reasoning_effort' / 'reasoning' fields
     *   - uses max_tokens, not max_completion_tokens
     *   - stream_options.include_usage not supported
     */
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
      thinkingFormat: "zai",         // z.ai = 智谱 AI, uses top-level enable_thinking: boolean
    },
  };
}

/**
 * Build a DeepSeek model. DeepSeek's chat API is OpenAI-compatible
 * (https://api.deepseek.com/chat/completions), supports tool_calls,
 * JSON mode, 1M context. Pricing per 1M tokens (CNY): flash 1¥/2¥
 * input/output, pro 12¥/24¥. Cache-hit input is 5x cheaper.
 *
 * No `compat` overrides needed — DeepSeek implements OpenAI's chat
 * spec faithfully (developer role yes, store no, no reasoning_effort
 * field on the V4 line; pi-ai's defaults match).
 */
function buildDeepseekModel(modelId: string): Model<"openai-completions"> {
  const priceTable: Record<string, { input: number; output: number; ctx: number; max: number }> = {
    "deepseek-v4-flash": { input: 1.0,  output: 2.0,  ctx: 1_000_000, max: 384_000 },
    "deepseek-v4-pro":   { input: 12.0, output: 24.0, ctx: 1_000_000, max: 384_000 },
    // legacy V3 IDs in case the scheduler config still references them
    "deepseek-chat":     { input: 0.27, output: 1.10, ctx: 64_000,    max: 8_192 },
    "deepseek-reasoner": { input: 0.55, output: 2.19, ctx: 64_000,    max: 8_192 },
  };
  const p = priceTable[modelId] ?? priceTable["deepseek-v4-flash"];
  return {
    id: modelId,
    name: `${modelId} (DeepSeek)`,
    api: "openai-completions",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    reasoning: false,        // V4-flash defaults to non-thinking; pro can think but we don't enable it here
    input: ["text"],
    cost: { input: p.input, output: p.output, cacheRead: p.input * 0.2, cacheWrite: 0 },
    contextWindow: p.ctx,
    maxTokens: p.max,
  };
}

function resolveByProvider(modelId: string): Model<any> {
  if (config.llm.provider === ("glm" as any)) return buildGlmModel(modelId);
  if (config.llm.provider === ("deepseek" as any)) return buildDeepseekModel(modelId);
  return getModel(config.llm.provider as any, modelId as any);
}

/** Deep-scan model (thorough, slower). Used for full workflows + brain updates. */
export function resolveScanModel(): Model<any> {
  return resolveByProvider(config.llm.model);
}

/** Fast-scan model (lightweight, high frequency). Typically cheaper/faster. */
export function resolveFastModel(): Model<any> {
  return resolveByProvider(config.llm.fastModel);
}

/** Chat model — defaults to deep model. */
export function resolveChatModel(): Model<any> {
  return resolveByProvider(config.llm.chatModel || config.llm.model);
}
