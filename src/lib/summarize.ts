/**
 * Cheap-LLM summarizer. Point: before a heavy tool return flows through the
 * main reasoning model (glm-5.1) and 20+ agent turns, run a cheaper model
 * (glm-4.5-air or glm-4-flash) once to compress it into a 1-2 sentence
 * narrative + a structured extracted object.
 *
 * Behavior contract:
 *   - summarize() never throws. On failure / timeout the original caller
 *     just skips narrative enrichment; tool correctness is unaffected.
 *   - No pi-agent-core dependency: this is a plain openai-compatible
 *     fetch() to the GLM endpoint. Keeps the dependency surface tiny.
 *   - Output is cached by sha of the input for the duration of one scan
 *     (rare but possible duplicate calls — e.g. same symbol surfaced by
 *     gmgn_trending AND smartmoney_buys — only one LLM charge).
 */
import { createHash } from "node:crypto";
import { config } from "../config.js";

const CHEAP_MODEL = process.env.BRIEF_LLM_MODEL ?? "glm-4.5-air";

const cache = new Map<string, string>();

function hashKey(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

async function callCheapLLM(prompt: string, maxTokens = 200): Promise<string | null> {
  const apiKey = config.llm.getApiKey("glm");
  if (!apiKey) return null;
  try {
    const res = await fetch(
      "https://open.bigmodel.cn/api/paas/v4/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: CHEAP_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.3,
        }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!res.ok) {
      console.error(`[summarize] ${CHEAP_MODEL} HTTP ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return typeof text === "string" ? text.trim() : null;
  } catch (e: any) {
    console.error(`[summarize] ${CHEAP_MODEL} error:`, e?.message ?? e);
    return null;
  }
}

/**
 * Summarize a blob of tool-output text with a caller-provided prompt hint.
 * Returns a 1-2 sentence narrative, or null if the cheap LLM is unavailable.
 */
export async function summarize(
  promptHint: string,
  body: string,
  opts?: { maxTokens?: number }
): Promise<string | null> {
  const key = hashKey(promptHint + body);
  const cached = cache.get(key);
  if (cached) return cached;

  const prompt =
    `${promptHint}\n\n` +
    `数据：\n${body.slice(0, 8000)}\n\n` +  // 8k char cap — cheap model context budget
    `请用 1-2 句中文概括关键信号。禁止编造，只用数据里出现的数字和事实。不超过 100 字。`;

  const result = await callCheapLLM(prompt, opts?.maxTokens ?? 200);
  if (result) cache.set(key, result);
  return result;
}

/**
 * Clear the per-scan cache. Call once when a new scan starts if you don't
 * want cross-scan caching (sometimes you do — e.g. symbol narratives that
 * rarely change).
 */
export function clearSummarizeCache(): void {
  cache.clear();
}
