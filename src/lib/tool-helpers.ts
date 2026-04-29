import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Static, TSchema } from "@sinclair/typebox";

/**
 * Wrap a simple JSON-returning function into an AgentTool with the boilerplate
 * (label propagation, AgentToolResult shape, error handling).
 */
export function defineJsonTool<TParameters extends TSchema, TDetails = unknown>(opts: {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  /** Caller returns whatever JSON-serializable value the LLM should see. */
  run: (params: Static<TParameters>) => Promise<TDetails> | TDetails;
}): AgentTool<TParameters, TDetails> {
  return {
    name: opts.name,
    label: opts.label,
    description: opts.description,
    parameters: opts.parameters,
    execute: async (_toolCallId, params): Promise<AgentToolResult<TDetails>> => {
      const result = await opts.run(params);
      const text = typeof result === "string" ? result : JSON.stringify(result);
      return {
        content: [{ type: "text", text }],
        details: result as TDetails,
      };
    },
  };
}
