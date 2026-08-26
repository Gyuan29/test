"use client";

import { useSearchParams } from "next/navigation";
import { FormEvent, KeyboardEvent, ReactNode, useState } from "react";

type Message = { role: "user" | "assistant"; content: string };
type StreamEvent = { type: "start" | "delta" | "done" | "error"; content?: string; sessionId?: string; error?: string };

export function ChatPanel() {
  const params = useSearchParams();
  const [sessionId, setSessionId] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const organization = params.get("organization");

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || sending) return;
    const conversation = [...messages, { role: "user" as const, content }];
    const assistantIndex = conversation.length;
    setDraft("");
    setMessages([...conversation, { role: "assistant", content: "" }]);
    setSending(true);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify({ sessionId: sessionId || undefined, organizationId: organization || undefined, message: content, messages: conversation }) });
      if (!response.ok) { const payload = await response.json().catch(() => ({})) as { detail?: string; error?: string }; throw new Error(payload.detail || payload.error || "聊天服务暂时不可用"); }
      if (!response.body) throw new Error("聊天服务没有返回数据流");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const consumeEvent = (rawEvent: string) => {
        const data = rawEvent.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
        if (!data) return;
        const payload = JSON.parse(data) as StreamEvent;
        if (payload.type === "start" && payload.sessionId) setSessionId(payload.sessionId);
        if (payload.type === "delta" && payload.content) setMessages((current) => current.map((item, index) => index === assistantIndex ? { ...item, content: item.content + payload.content } : item));
        if (payload.type === "error") throw new Error(payload.error || "模型返回错误");
      };
      while (true) { const result = await reader.read(); if (result.done) break; buffer += decoder.decode(result.value, { stream: true }); const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || ""; for (const rawEvent of events) consumeEvent(rawEvent); }
      buffer += decoder.decode();
      if (buffer.trim()) consumeEvent(buffer);
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法连接聊天服务，请稍后重试";
      setMessages((current) => current.map((item, index) => index === assistantIndex ? { ...item, content: `请求失败：${message}` } : item));
    } finally { setSending(false); }
  }

  function handleDraftKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) { if (event.key === "Enter" && !event.shiftKey && !event.ctrlKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }

  return (
    <div className="grid min-h-[620px] gap-8 lg:grid-cols-[0.7fr_1.3fr]">
      <section className="border-b border-[var(--line)] pb-7 lg:border-b-0 lg:border-r lg:pr-8"><p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-[var(--teal)]">Agent workspace</p><h1 className="text-3xl font-semibold tracking-tight">研究对话</h1><p className="mt-3 text-sm leading-6 text-slate-500">基于机构档案、事件和公开来源进行连续分析。</p>{organization ? <div className="mt-8 border-l-2 border-[var(--teal)] bg-[var(--teal-soft)] px-4 py-4"><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--teal)]">当前机构</p><p className="mt-2 text-sm font-medium text-[var(--ink)]">{organization}</p></div> : null}<div className="mt-8 space-y-3 text-xs text-slate-500"><p className="font-semibold text-slate-700">可以从这些问题开始</p><p className="border-l border-[var(--line)] pl-3">这家机构最近的公开信号是什么？</p><p className="border-l border-[var(--line)] pl-3">它与哪些区域和技术方向相关？</p></div></section>
      <section className="flex min-h-[560px] flex-col border border-[var(--line)] bg-white"><div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-4"><div><p className="text-sm font-semibold">机构情报 Agent</p><p className="mt-1 text-xs text-slate-400">会话 {sessionId ? sessionId.slice(0, 8) : "未开始"}</p></div><span className="font-mono text-[10px] text-slate-400">API / CHAT</span></div><div className="flex-1 space-y-4 overflow-y-auto px-5 py-6">{messages.length ? messages.map((message, index) => <div className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`} key={`${message.role}-${index}`}><div className={`max-w-[85%] px-4 py-3 text-sm leading-6 ${message.role === "user" ? "bg-[var(--ink)] text-white whitespace-pre-wrap" : "bg-[#f1f5f4] text-slate-700"}`}>{message.role === "assistant" ? <MarkdownContent content={message.content || (sending ? "…" : "")} /> : message.content}</div></div>) : <div className="flex h-full min-h-64 items-center justify-center text-center"><div><p className="font-medium text-slate-600">从一个研究问题开始</p><p className="mt-2 text-xs text-slate-400">消息将通过本地模型实时生成。</p></div></div>}{sending ? <div className="text-xs text-slate-400">Agent 正在生成回答…</div> : null}</div><form className="border-t border-[var(--line)] p-4" onSubmit={send}><label className="sr-only" htmlFor="chat-message">输入研究问题</label><div className="flex gap-3"><textarea className="focus-ring min-h-12 flex-1 resize-none border border-[var(--line)] bg-[#fbfcfc] px-3 py-3 text-sm outline-none placeholder:text-slate-400" id="chat-message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={handleDraftKeyDown} placeholder="输入一个关于机构、事件或来源的问题" /><button className="focus-ring self-end bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white hover:bg-[#263758] disabled:cursor-not-allowed disabled:opacity-50" disabled={sending || !draft.trim()} type="submit">发送</button></div></form></section>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }): ReactNode { if (!content) return null; return <div className="space-y-2">{content.split(/\r?\n/).map((line, index) => { const trimmed = line.trim(); if (!trimmed) return <div className="h-2" key={`blank-${index}`} />; if (/^#{1,3}\s/.test(trimmed)) return <p className="font-semibold text-[var(--ink)]" key={index}>{inlineMarkdown(trimmed.replace(/^#{1,3}\s+/, ""), index)}</p>; if (/^[-*]\s/.test(trimmed)) return <p className="pl-3" key={index}>• {inlineMarkdown(trimmed.slice(2), index)}</p>; return <p key={index}>{inlineMarkdown(trimmed, index)}</p>; })}</div>; }
function inlineMarkdown(value: string, seed: number): ReactNode[] { const parts = value.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^\)]+\))/g); return parts.map((part, index) => { const bold = part.match(/^\*\*(.+)\*\*$/); if (bold) return <strong key={`${seed}-${index}`}>{bold[1]}</strong>; const code = part.match(/^`(.+)`$/); if (code) return <code className="bg-slate-200 px-1" key={`${seed}-${index}`}>{code[1]}</code>; const link = part.match(/^\[([^\]]+)\]\(([^\)]+)\)$/); if (link) return <a className="text-[var(--teal)] underline" href={link[2]} target="_blank" rel="noreferrer" key={`${seed}-${index}`}>{link[1]}</a>; return part; }); }
