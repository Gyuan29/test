import Link from "next/link";
import { notFound } from "next/navigation";
import { getDatabase, type EventRow } from "@/lib/db";
import { normalizeEventDate, normalizeEventDescription, normalizeEventTitle } from "@/lib/event-display";

export const dynamic = "force-dynamic";

function displayDate(value: string | null | undefined): string {
  if (!value || value.toLowerCase() === "unknown") return "日期未知";
  const normalized = normalizeEventDate(value);
  if (!normalized) return "日期未知";
  const date = new Date(normalized);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "long" }).format(date);
}

function hostname(value: string | null | undefined): string {
  if (!value) return "未知网站";
  try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return value; }
}

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDatabase();
  if (!db) return <Message text="数据库尚未配置" />;
  const row = await db.prepare("SELECT e.*, o.name AS organization_name, o.slug AS organization_slug, o.website_url AS organization_website FROM events e JOIN organizations o ON o.entity_id = e.organization_id WHERE e.id = ? LIMIT 1").bind(id).first<EventRow & { organization_name: string; organization_slug: string; organization_website: string | null }>();
  if (!row) notFound();

  const title = normalizeEventTitle(row.translated_title ?? row.title, normalizeEventTitle(row.title));
  const description = normalizeEventDescription(row.translated_description ?? row.summary, row.summary?.trim() || title);
  return (
    <main className="mx-auto max-w-4xl space-y-8">
      <Link className="text-sm font-semibold text-[var(--teal)] hover:underline" href="/events">← 返回事件档案</Link>
      <article className="border-y border-[var(--line)] bg-white px-6 py-8 sm:px-8">
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          <span className="font-mono text-[var(--coral)]">{displayDate(row.event_date)}</span>
          {row.event_type ? <span className="border border-slate-200 px-2 py-1">{row.event_type}</span> : null}
        </div>
        <h1 className="mt-4 text-3xl font-semibold leading-tight text-[var(--ink)]">{title}</h1>
        <p className="mt-3 text-sm text-slate-500">来源机构：<Link className="text-[var(--teal)] hover:underline" href={`/organizations/${row.organization_slug}`}>{row.organization_name}</Link></p>
        <div className="mt-8 whitespace-pre-wrap text-base leading-8 text-slate-700">{description}</div>
      </article>
      <section className="grid gap-4 sm:grid-cols-2">
        <div className="border-y border-[var(--line)] bg-white px-5 py-4"><p className="text-xs text-slate-400">来源网站</p><p className="mt-2 text-sm font-medium text-[var(--ink)]">{row.source_name || hostname(row.source_url)}</p><p className="mt-1 break-all text-xs text-slate-500">{hostname(row.source_url || row.organization_website)}</p></div>
        <div className="border-y border-[var(--line)] bg-white px-5 py-4"><p className="text-xs text-slate-400">原文链接</p>{row.source_url ? <a className="mt-2 block break-all text-sm font-medium text-[var(--teal)] hover:underline" href={row.source_url} target="_blank" rel="noreferrer">打开原文 ↗</a> : <p className="mt-2 text-sm text-slate-500">暂无原文链接</p>}</div>
      </section>
    </main>
  );
}

function Message({ text }: { text: string }) { return <main className="mx-auto max-w-4xl border-y border-[var(--line)] bg-white px-6 py-12 text-center text-sm text-slate-500">{text}</main>; }
