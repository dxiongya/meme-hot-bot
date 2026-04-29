import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { v4 as uuidv4 } from "uuid";
import { createChatAgent } from "../agent/agent-factory.js";
import { db } from "../../../db/client.js";

export const chatApi = new Hono();

/**
 * Per-session in-memory agent cache. Lost on server restart; chat history is
 * persisted to chat_messages so the next session can recover transcript
 * (proper hydration is Phase B work).
 */
const sessionAgents = new Map<string, ReturnType<typeof createChatAgent>>();

function getOrCreateAgent(sessionId: string) {
  let agent = sessionAgents.get(sessionId);
  if (!agent) {
    agent = createChatAgent();
    sessionAgents.set(sessionId, agent);
  }
  return agent;
}

chatApi.post("/", async (c) => {
  const { message, sessionId: incoming } = await c.req.json<{
    message: string;
    sessionId?: string;
  }>();
  if (!message?.trim()) {
    return c.json({ error: "message is required" }, 400);
  }
  const sessionId = incoming ?? uuidv4();

  // Ensure session row
  await db.query(
    `INSERT INTO chat_sessions (id) VALUES ($1) ON CONFLICT DO NOTHING`,
    [sessionId]
  );
  await db.query(
    `INSERT INTO chat_messages (id, session_id, role, content)
     VALUES ($1, $2, 'user', $3)`,
    [uuidv4(), sessionId, message]
  );

  const agent = getOrCreateAgent(sessionId);

  return streamSSE(c, async (stream) => {
    let assistantBuffer = "";
    const toolBuffer: Array<{ name: string; ok: boolean }> = [];

    const off = agent.subscribe((event) => {
      if (event.type === "message_update") {
        const ev = (event as any).assistantMessageEvent;
        if (ev?.type === "text_delta" && typeof ev.delta === "string") {
          assistantBuffer += ev.delta;
          stream.writeSSE({ event: "delta", data: ev.delta }).catch(() => {});
        }
      }
      if (event.type === "tool_execution_start") {
        const e = event as any;
        stream
          .writeSSE({
            event: "tool_start",
            data: JSON.stringify({ name: e.toolName, args: e.args }),
          })
          .catch(() => {});
      }
      if (event.type === "tool_execution_end") {
        const e = event as any;
        toolBuffer.push({ name: e.toolResult?.toolName, ok: !e.toolResult?.isError });
        stream
          .writeSSE({
            event: "tool_end",
            data: JSON.stringify({
              name: e.toolResult?.toolName,
              ok: !e.toolResult?.isError,
            }),
          })
          .catch(() => {});
      }
      if (event.type === "agent_end") {
        stream.writeSSE({ event: "done", data: JSON.stringify({ sessionId }) }).catch(() => {});
      }
    });

    try {
      await agent.prompt(message);
    } catch (e) {
      stream
        .writeSSE({ event: "error", data: JSON.stringify({ error: String(e) }) })
        .catch(() => {});
    } finally {
      off();
      await db.query(
        `INSERT INTO chat_messages (id, session_id, role, content, tool_calls)
         VALUES ($1, $2, 'assistant', $3, $4::jsonb)`,
        [uuidv4(), sessionId, assistantBuffer, JSON.stringify(toolBuffer)]
      );
    }
  });
});

chatApi.get("/sessions/:id/messages", async (c) => {
  const id = c.req.param("id");
  const r = await db.query(
    `SELECT id, role, content, tool_calls, ts FROM chat_messages WHERE session_id = $1 ORDER BY ts ASC`,
    [id]
  );
  return c.json({ messages: r.rows });
});
