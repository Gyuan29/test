import { asc, desc, eq, like, or } from "drizzle-orm";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { events, organizations } from "@/db/schema";
import { currentUser } from "@/lib/auth";
import { getAdminDatabase } from "@/lib/admin-db";
import { getDatabase, json, mapChatSession } from "@/lib/db";
import { createRateLimiter } from "@/lib/request-limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type ChatRole = "user" | "assistant";
type ChatMessage = { role: ChatRole; content: string; createdAt?: string };
type ChatRequest = { sessionId?: string; organizationId?: string; message?: string; messages?: ChatMessage[] };
const SYSTEM_PROMPT = "你是专业的机构情报分析助手。涉及机构、官网、事件或最新动态时，必须优先调用 search_institution_database。回答只能依据工具返回的公开字段；数据库没有相关记录时必须如实说明，禁止猜测或编造。";
const DATABASE_TOOL: ChatCompletionTool = { type: "function", function: { name: "search_institution_database", description: "查询机构及其公开事件信息", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "number", minimum: 1, maximum: 10 } }, required: ["query"], additionalProperties: false } } };
const baseUrl = (process.env.LLM_BASE_URL?.trim() || "http://localhost:11434/v1").replace(/\/+$/, "");
const apiKey = process.env.LLM_API_KEY?.trim() || "ollama";
const modelName = process.env.LLM_MODEL_NAME?.trim() || "qwen2.5:3b";
const chatRateLimiter = createRateLimiter(20, 60_000);

function safeMessages(messages: unknown): ChatMessage[] { if (!Array.isArray(messages)) return []; return messages.filter((item): item is ChatMessage => Boolean(item) && typeof item === "object" && (((item as ChatMessage).role === "user") || (item as ChatMessage).role === "assistant") && typeof (item as ChatMessage).content === "string").map((item) => ({ role: item.role, content: item.content.slice(0, 8_000) })).slice(-40); }
function sseHeaders(): HeadersInit { return { "cache-control": "no-cache, no-transform", "content-type": "text/event-stream; charset=utf-8", connection: "keep-alive", "x-accel-buffering": "no" }; }
function encodeEvent(encoder: TextEncoder, value: unknown): Uint8Array { return encoder.encode(`data: ${JSON.stringify(value)}\n\n`); }
function extractDelta(value: unknown): string { const content = (value as { choices?: Array<{ delta?: { content?: unknown } }> })?.choices?.[0]?.delta?.content; return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "").join("") : ""; }
function escapeLike(value: string): string { return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_"); }
function toolArguments(value: string): { query: string; limit: number } { try { const parsed = JSON.parse(value) as { query?: unknown; limit?: unknown }; return { query: typeof parsed.query === "string" ? parsed.query.slice(0, 200) : "", limit: typeof parsed.limit === "number" ? Math.min(10, Math.max(1, Math.floor(parsed.limit))) : 3 }; } catch { return { query: "", limit: 3 }; } }

async function searchInstitutionDatabase(query: string, requestedLimit = 3): Promise<string> {
  const normalized = query.trim().slice(0, 200); if (!normalized) return JSON.stringify({ query, matches: [] });
  const limit = Math.min(10, Math.max(1, Math.floor(requestedLimit))); const db = await getAdminDatabase(); const pattern = `%${escapeLike(normalized)}%`;
  const rows = await db.select({ entityId: organizations.entityId, name: organizations.name, websiteUrl: organizations.websiteUrl, description: organizations.description, eventTitle: events.title, eventDate: events.eventDate, eventType: events.eventType }).from(organizations).leftJoin(events, eq(events.organizationId, organizations.entityId)).where(or(like(organizations.name, pattern), like(organizations.description, pattern))).orderBy(asc(organizations.name), desc(events.eventDate)).limit(limit * 4).all();
  const grouped = new Map<string, { entityId: string; name: string; websiteUrl: string | null; description: string | null; events: Array<{ title: string; eventDate: string; eventType: string | null }> }>();
  for (const row of rows) { const item = grouped.get(row.entityId) || { entityId: row.entityId, name: row.name, websiteUrl: row.websiteUrl ?? null, description: row.description ?? null, events: [] as Array<{ title: string; eventDate: string; eventType: string | null }> }; if (row.eventTitle && item.events.length < 3) item.events.push({ title: row.eventTitle, eventDate: row.eventDate ?? "", eventType: row.eventType ?? null }); grouped.set(row.entityId, item); }
  return JSON.stringify({ query: normalized, matches: [...grouped.values()].slice(0, limit) });
}

async function persistConversation(sessionId: string, organizationId: string | undefined, messages: ChatMessage[], userId: string, db: D1Database, now: string): Promise<boolean> { const existing = await db.prepare("SELECT * FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1").bind(sessionId, userId).first<Record<string, unknown>>(); if (existing?.revoked_at) return false; if (existing) { let stored: ChatMessage[] = []; try { stored = JSON.parse(mapChatSession(existing).messagesJson) as ChatMessage[]; } catch { stored = []; } await db.prepare("UPDATE chat_sessions SET messages_json = ?, updated_at = ? WHERE id = ? AND user_id = ?").bind(JSON.stringify([...stored, ...messages]), now, sessionId, userId).run(); } else { await db.prepare("INSERT INTO chat_sessions (id, user_id, organization_id, title, messages_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(sessionId, userId, organizationId ?? null, messages.find((message) => message.role === "user")?.content.slice(0, 80) || "机构情报对话", JSON.stringify(messages), now, now).run(); } return true; }

export async function GET(request: Request): Promise<Response> { const db = await getDatabase(); if (!db) return json({ items: [], configured: false }); const user = await currentUser(request, db); if (!user) return json({ error: "authentication_required" }, { status: 401 }); if (!chatRateLimiter.allow(user.id)) return json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } }); const result = await db.prepare("SELECT id, user_id, organization_id, title, messages_json, revoked_at, created_at, updated_at FROM chat_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY updated_at DESC LIMIT 100").bind(user.id).all<Record<string, unknown>>(); return json({ items: result.results.map(mapChatSession), configured: true }); }

export async function POST(request: Request): Promise<Response> {
  const db = await getDatabase(); if (!db) return json({ error: "database_unconfigured" }, { status: 503 }); const user = await currentUser(request, db); if (!user) return json({ error: "authentication_required" }, { status: 401 });
  if (!chatRateLimiter.allow(user.id)) return json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
  if (Number(request.headers.get("content-length") || 0) > 1_000_000) return json({ error: "request_too_large" }, { status: 413 });
  let body: ChatRequest; try { const raw = await request.text(); if (raw.length > 1_000_000) return json({ error: "request_too_large" }, { status: 413 }); body = JSON.parse(raw) as ChatRequest; } catch { return json({ error: "invalid_json" }, { status: 400 }); }
  const message = body.message?.trim() || ""; if (!message || message.length > 8_000) return json({ error: "message_required_or_too_long" }, { status: 400 }); const history = safeMessages(body.messages); if (!history.some((item) => item.role === "user" && item.content === message)) history.push({ role: "user", content: message });
  const sessionId = body.sessionId || crypto.randomUUID(); const existing = await db.prepare("SELECT revoked_at FROM chat_sessions WHERE id = ? AND user_id = ? LIMIT 1").bind(sessionId, user.id).first<{ revoked_at: string | null }>(); if (existing?.revoked_at) return json({ error: "session_revoked" }, { status: 410 });
  const modelMessages: Array<Record<string, unknown>> = [{ role: "system", content: SYSTEM_PROMPT }, ...history];
  try {
    // 融合逻辑：先执行 A 的 Tool Calling，再将可信公开数据交给 B 的 SSE 请求。
    const decision = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json", authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ model: modelName, messages: modelMessages, tools: [DATABASE_TOOL], tool_choice: "auto", stream: false, temperature: 0.1 }) });
    if (decision.ok) { const payload = await decision.json() as { choices?: Array<{ message?: { tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }> } }> }; for (const call of payload.choices?.[0]?.message?.tool_calls || []) { if (call.function.name !== "search_institution_database") continue; const args = toolArguments(call.function.arguments); modelMessages.push({ role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: call.id, content: await searchInstitutionDatabase(args.query, args.limit) }); } } else { modelMessages.push({ role: "user", content: `仅基于以下数据库公开结果回答：${await searchInstitutionDatabase(message, 3)}` }); }
  } catch { modelMessages.push({ role: "user", content: `仅基于以下数据库公开结果回答：${await searchInstitutionDatabase(message, 3)}` }); }
  let upstream: Response; try { upstream = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { accept: "text/event-stream", "content-type": "application/json", authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ model: modelName, messages: modelMessages, stream: true, temperature: 0.2 }) }); } catch { return json({ error: "llm_unreachable" }, { status: 502 }); }
  if (!upstream.ok || !upstream.body) { try { await upstream.body?.cancel(); } catch {} return json({ error: "llm_request_failed" }, { status: 502 }); }
  const encoder = new TextEncoder(); const stream = new ReadableStream<Uint8Array>({ async start(controller) { let assistantText = ""; let buffer = ""; const reader = upstream.body!.getReader(); const decoder = new TextDecoder(); controller.enqueue(encodeEvent(encoder, { type: "start", sessionId })); const consume = (line: string) => { if (!line.startsWith("data:")) return; const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") return; try { const delta = extractDelta(JSON.parse(raw)); if (delta) { assistantText += delta; controller.enqueue(encodeEvent(encoder, { type: "delta", content: delta })); } } catch {} }; try { while (true) { const result = await reader.read(); if (result.done) break; buffer += decoder.decode(result.value, { stream: true }); const lines = buffer.split(/\r?\n/); buffer = lines.pop() || ""; for (const line of lines) consume(line); } buffer += decoder.decode(); if (buffer) consume(buffer); const now = new Date().toISOString(); const persisted = await persistConversation(sessionId, body.organizationId, [...history, { role: "assistant", content: assistantText, createdAt: now }], user.id, db, now); controller.enqueue(encodeEvent(encoder, { type: "done", sessionId, persisted })); } catch { controller.enqueue(encodeEvent(encoder, { type: "error", error: "llm_stream_failed" })); } finally { reader.releaseLock(); controller.close(); } } });
  return new Response(stream, { headers: sseHeaders() });
}

export async function DELETE(request: Request): Promise<Response> { const db = await getDatabase(); if (!db) return json({ error: "database_unconfigured" }, { status: 503 }); const user = await currentUser(request, db); const sessionId = new URL(request.url).searchParams.get("sessionId"); if (!user || !sessionId) return json({ error: "authentication_and_session_required" }, { status: 400 }); await db.prepare("UPDATE chat_sessions SET revoked_at = ?, updated_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), new Date().toISOString(), sessionId, user.id).run(); return json({ ok: true, sessionId }); }
