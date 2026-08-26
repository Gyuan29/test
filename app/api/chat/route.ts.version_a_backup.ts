import { asc, desc, eq, like, or } from "drizzle-orm";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import { getAdminDatabase } from "@/lib/admin-db";
import { getDatabase, json, mapChatSession } from "@/lib/db";
import { events, organizations } from "@/db/schema";
import { llmClient, LLM_MODEL_NAME } from "@/lib/llm-client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ChatRole = "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string; createdAt?: string };
type ChatRequest = { sessionId?: string; organizationId?: string; message?: string; messages?: ChatMessage[] };

const SYSTEM_PROMPT = "你是一个专业的机构情报分析助手。当用户提供查询时，你必须优先使用 search_institution_database 工具获取最新数据。你的回答必须严格基于工具返回的数据；如果数据中没有相关信息，请如实告知，绝对不要编造（No Hallucination）。只引用工具返回的公开字段，不要推测内部信息。";

const DATABASE_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "search_institution_database",
    description: "当用户询问特定机构、组织或其最新动态时，调用此工具查询本地数据库。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "用户想查询的机构名称或关键词" },
        limit: { type: "number", description: "最多返回的机构数量，默认 3，范围 1-10" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
};

function requestUserId(request: Request): string | null { return request.headers.get("x-user-id")?.trim() || null; }
function safeMessages(messages: unknown): ChatMessage[] {
  if (!Array.isArray(messages)) return [];
  return messages.filter((item): item is ChatMessage => Boolean(item) && typeof item === "object" && ((item as ChatMessage).role === "user" || (item as ChatMessage).role === "assistant") && typeof (item as ChatMessage).content === "string").map((item) => ({ role: item.role, content: item.content.slice(0, 8_000) })).slice(-40);
}
function sseHeaders(): HeadersInit { return { "cache-control": "no-cache, no-transform", "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" }; }
function encodeEvent(encoder: TextEncoder, value: unknown): Uint8Array { return encoder.encode(`data: ${JSON.stringify(value)}\n\n`); }
function escapeLike(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"); }
function shouldLookup(message: string, organizationId?: string): boolean { return Boolean(organizationId) || /(机构|组织|大学|学院|公司|研究院|实验室|基金会|协会|官网|事件|动态|最近|institution|organization|university|company|institute|latest|recent)/iu.test(message); }

type PublicSearchResult = { entityId: string; name: string; websiteUrl: string | null; description: string | null; events: Array<{ title: string; eventDate: string; eventType: string | null }> };

async function searchInstitutionDatabase(query: string, requestedLimit = 3): Promise<string> {
  const normalizedQuery = query.trim().slice(0, 200);
  const limit = Math.min(10, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 3));
  if (!normalizedQuery) return JSON.stringify({ query, matches: [], message: "查询关键词为空" });
  const db = await getAdminDatabase();
  const pattern = `%${escapeLike(normalizedQuery)}%`;
  const rows = await db.select({ entityId: organizations.entityId, name: organizations.name, websiteUrl: organizations.websiteUrl, description: organizations.description, eventTitle: events.title, eventDate: events.eventDate, eventType: events.eventType }).from(organizations).leftJoin(events, eq(events.organizationId, organizations.entityId)).where(or(like(organizations.name, pattern), like(organizations.description, pattern))).orderBy(asc(organizations.name), desc(events.eventDate)).limit(limit * 4).all();
  const grouped = new Map<string, PublicSearchResult>();
  for (const row of rows) {
    const current = grouped.get(row.entityId) || { entityId: row.entityId, name: row.name, websiteUrl: row.websiteUrl ?? null, description: row.description ?? null, events: [] };
    if (row.eventTitle && current.events.length < 3) current.events.push({ title: row.eventTitle, eventDate: row.eventDate ?? "", eventType: row.eventType ?? null });
    grouped.set(row.entityId, current);
  }
  return JSON.stringify({ query: normalizedQuery, matches: [...grouped.values()].slice(0, limit) });
}

function toolArguments(value: string): { query: string; limit: number } {
  try {
    const parsed = JSON.parse(value) as { query?: unknown; limit?: unknown };
    return { query: typeof parsed.query === "string" ? parsed.query : "", limit: typeof parsed.limit === "number" ? parsed.limit : 3 };
  } catch { return { query: "", limit: 3 }; }
}

async function appendDatabaseContext(messages: ChatCompletionMessageParam[], query: string, limit: number, toolCallId: string): Promise<void> {
  const content = await searchInstitutionDatabase(query, limit);
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: toolCallId, type: "function", function: { name: "search_institution_database", arguments: JSON.stringify({ query, limit }) } }] });
  messages.push({ role: "tool", tool_call_id: toolCallId, content });
}

async function appendPlainDatabaseContext(messages: ChatCompletionMessageParam[], query: string, limit: number): Promise<void> {
  const content = await searchInstitutionDatabase(query, limit);
  messages.push({ role: "user", content: `本地数据库查询结果（仅可依据这些公开数据回答）：${content}` });
}

async function persistConversation(sessionId: string, organizationId: string | undefined, messages: ChatMessage[], userId: string | null, db: D1Database | null, now: string): Promise<boolean> {
  if (!db || !userId) return false;
  const existing = await db.prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1").bind(sessionId, userId).first<Record<string, unknown>>();
  if (existing) {
    let stored: ChatMessage[] = [];
    try { stored = JSON.parse(mapChatSession(existing).messagesJson) as ChatMessage[]; } catch { stored = []; }
    await db.prepare("UPDATE chat_sessions SET messages_json = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(JSON.stringify([...stored, ...messages]), now, sessionId, userId).run();
  } else {
    await db.prepare("INSERT INTO chat_sessions (id, user_id, organization_id, title, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(sessionId, userId, organizationId ?? null, messages.find((message) => message.role === "user")?.content.slice(0, 80) || "机构情报对话", JSON.stringify(messages), now, now).run();
  }
  return true;
}

export async function GET(request: Request) {
  const db = await getDatabase();
  if (!db) return json({ items: [], configured: false });
  const userId = requestUserId(request);
  if (!userId) return json({ error: "authentication_required" }, { status: 401 });
  const result = await db.prepare("SELECT id, user_id, organization_id, title, messages_json, revoked_at, created_at, updated_at FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100").bind(userId).all<Record<string, unknown>>();
  return json({ items: result.results.map(mapChatSession), configured: true });
}

export async function POST(request: Request) {
  let body: ChatRequest;
  try { body = (await request.json()) as ChatRequest; } catch { return json({ error: "invalid_json" }, { status: 400 }); }
  const message = body.message?.trim() ?? "";
  if (!message || message.length > 8_000) return json({ error: "message_required_or_too_long" }, { status: 400 });
  const history = safeMessages(body.messages);
  if (!history.some((item) => item.role === "user" && item.content === message)) history.push({ role: "user", content: message });
  const sessionId = body.sessionId || crypto.randomUUID();
  const modelMessages: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM_PROMPT }, ...history.map(({ role, content }) => ({ role, content }))];
  const lookupRequired = shouldLookup(message, body.organizationId);

  try {
    const decision = await llmClient.chat.completions.create({ model: LLM_MODEL_NAME, messages: modelMessages, tools: [DATABASE_TOOL], tool_choice: lookupRequired ? "required" : "auto", stream: false, temperature: 0.1 });
    const assistant = decision.choices[0]?.message;
    const calls = assistant?.tool_calls?.filter((call) => call.type === "function") || [];
    if (calls.length) {
      modelMessages.push(assistant);
      for (const call of calls) {
        const args = toolArguments(call.function.arguments);
        await appendDatabaseContext(modelMessages, args.query, args.limit, call.id);
      }
    } else if (lookupRequired) {
      // Ollama versions that ignore tool_choice may still reject tool-role
      // messages, so inject the verified result as plain context.
      await appendPlainDatabaseContext(modelMessages, message, 3);
    }
  } catch (error) {
    if (lookupRequired) {
      try { await appendPlainDatabaseContext(modelMessages, message, 3); } catch (toolError) { console.error("Database tool failed", toolError); }
    } else {
      console.warn("Tool decision unavailable; continuing with direct model response", error);
    }
  }

  const encoder = new TextEncoder();
  const userId = requestUserId(request);
  const db = await getDatabase();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let assistantText = "";
      controller.enqueue(encodeEvent(encoder, { type: "start", sessionId }));
      try {
        const completion = await llmClient.chat.completions.create({ model: LLM_MODEL_NAME, messages: modelMessages, stream: true, temperature: 0.2 });
        for await (const chunk of completion) {
          const content = chunk.choices[0]?.delta?.content;
          const delta = typeof content === "string" ? content : "";
          if (delta) { assistantText += delta; controller.enqueue(encodeEvent(encoder, { type: "delta", content: delta })); }
        }
        const now = new Date().toISOString();
        const persisted = await persistConversation(sessionId, body.organizationId, [...history, { role: "assistant", content: assistantText, createdAt: now }], userId, db, now);
        controller.enqueue(encodeEvent(encoder, { type: "done", sessionId, persisted }));
      } catch (error) {
        controller.enqueue(encodeEvent(encoder, { type: "error", error: error instanceof Error ? error.message : String(error) }));
      } finally { controller.close(); }
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

export async function DELETE(request: Request) {
  const db = await getDatabase();
  if (!db) return json({ error: "database_unconfigured" }, { status: 503 });
  const userId = requestUserId(request);
  const sessionId = new URL(request.url).searchParams.get("sessionId");
  if (!userId || !sessionId) return json({ error: "authentication_and_session_required" }, { status: 400 });
  await db.prepare("UPDATE chat_sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(new Date().toISOString(), new Date().toISOString(), sessionId, userId).run();
  return json({ ok: true, sessionId });
}
