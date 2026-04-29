import "dotenv/config";

function req(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/** Map provider id -> its env var; returns empty string if not set. */
export function getApiKeyForProvider(provider: string): string {
  switch (provider) {
    case "anthropic":   return process.env.ANTHROPIC_API_KEY ?? "";
    case "openai":      return process.env.OPENAI_API_KEY ?? "";
    case "openrouter":  return process.env.OPENROUTER_API_KEY ?? "";
    case "google":      return process.env.GOOGLE_API_KEY ?? "";
    case "google-vertex": return process.env.GOOGLE_API_KEY ?? "";
    case "glm":         return process.env.GLM_API_KEY ?? "";
    case "deepseek":    return process.env.DEEPSEEK_API_KEY ?? "";
    default:            return process.env[`${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`] ?? "";
  }
}

export const config = {
  port: parseInt(process.env.PORT ?? "3000", 10),
  databaseUrl: req("DATABASE_URL"),
  brainDir: process.env.BRAIN_DIR ?? "./brain",
  proxy: {
    https: process.env.HTTPS_PROXY ?? "",
    http: process.env.HTTP_PROXY ?? "",
    /** Binance-only override (e.g., Surge on residential IP to bypass US 451) */
    binance: process.env.BINANCE_PROXY ?? "",
  },
  xapi: {
    apiKey: process.env.XAPI_API_KEY ?? "",
  },
  telegram: {
    enabled: (process.env.TELEGRAM_ENABLED ?? "true") === "true",
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },
  llm: {
    provider: (process.env.LLM_PROVIDER ?? "anthropic") as
      | "anthropic"
      | "openai"
      | "openrouter"
      | "google",
    /** Deep-scan model — thorough analysis, slower, called less often */
    model: process.env.LLM_MODEL ?? "claude-sonnet-4-7",
    /** Fast-scan model — high-frequency lightweight pass */
    fastModel: process.env.FAST_LLM_MODEL ?? process.env.LLM_MODEL ?? "claude-sonnet-4-7",
    /** Chat model — defaults to the deep model */
    chatModel: process.env.CHAT_LLM_MODEL ?? process.env.LLM_MODEL ?? "claude-sonnet-4-7",
    getApiKey: getApiKeyForProvider,
  },
  scan: {
    /** Meme module — deep scan cadence (full workflow + brain updates) */
    cron: process.env.SCAN_CRON ?? "*/30 * * * *",
    /** Meme module — fast scan cadence (lightweight momentum check) */
    fastCron: process.env.FAST_SCAN_CRON ?? "*/5 * * * *",
    chains: (process.env.SCAN_CHAINS ?? "sol,base,bsc,eth").split(","),
    autoStart: (process.env.SCAN_AUTO_START ?? "true") === "true",
    fastAutoStart: (process.env.FAST_SCAN_AUTO_START ?? process.env.SCAN_AUTO_START ?? "true") === "true",
  },
};
