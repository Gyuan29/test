import Link from "next/link";
import { notFound } from "next/navigation";
import { getDatabase, mapEvent, mapOrganization, type EventRow, type OrganizationRow } from "@/lib/db";

export const dynamic = "force-dynamic";

function formatDate(value: string): string {
  if (!value || value.toLowerCase() === "unknown") return "日期未知";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}

function websiteUrl(value: string | null): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export default async function OrganizationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const db = await getDatabase();
  if (!db) return <Message text="数据库尚未配置" />;
  const row = await db.prepare("SELECT * FROM organizations WHERE entity_id = ? OR slug = ? LIMIT 1").bind(id, id).first<OrganizationRow>();
  if (!row) notFound();
  const organization = mapOrganization(row);
  const eventsResult = await db.prepare("SELECT * FROM events WHERE organization_id = ? ORDER BY event_date DESC, created_at DESC LIMIT 100").bind(organization.entityId).all<EventRow>();
  const sourcesResult = await db.prepare("SELECT id, name, url, last_fetch_status FROM news_sources WHERE organization_slug = ? ORDER BY name ASC").bind(organization.slug).all<{ id: string; name: string; url: string; last_fetch_status: string | null }>().catch(() => ({ results: [] as { id: string; name: string; url: string; last_fetch_status: string | null }[] }));
  const events = eventsResult.results.map(mapEvent);
  const tags = [organization.entityType, organization.analysisType, ...(organization.relatedTypes || "").split(/[,，、]/).map((tag) => tag.trim()).filter(Boolean)].filter(Boolean) as string[];
  const officialUrl = websiteUrl(organization.websiteUrl);
  const description = organization.description || organization.summary || "暂无机构简介";

  return (
    <main className="mx-auto max-w-6xl space-y-8">
      <Link className="text-sm font-semibold text-[var(--teal)] hover:underline" href="/organizations">← 返回机构目录</Link>
      <section className="border-b border-[var(--line)] pb-8"><div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end"><div><p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--teal)]">机构档案</p><h1 className="mt-2 text-3xl font-semibold text-[var(--ink)]">{organization.name}</h1><p className="mt-3 text-sm text-slate-500">{organization.country} · {organization.region}{organization.founded ? ` · 成立于 ${organization.founded}` : ""}</p></div>{officialUrl ? <a className="bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white hover:bg-[#263758]" href={officialUrl} target="_blank" rel="noreferrer">官方网站 ↗</a> : null}</div></section>
      <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]"><div className="space-y-8"><section><Heading title="机构简介" /><div className="border-y border-[var(--line)] bg-white px-5 py-5 text-sm leading-7 text-slate-700">{description}</div></section><section><Heading title="近期事件" /><div className="border-y border-[var(--line)] bg-white">{events.length ? events.map((event) => <article className="grid gap-3 border-b border-[var(--line)] px-5 py-5 last:border-0 sm:grid-cols-[130px_1fr]" key={event.id}><p className="font-mono text-[11px] text-[var(--coral)]">{formatDate(event.eventDate)}</p><div><Link className="font-medium text-[var(--ink)] hover:text-[var(--teal)]" href={`/events/${event.id}`}>{event.translatedTitle || event.title}</Link><p className="mt-2 text-xs leading-5 text-slate-500">{event.translatedDescription || event.summary || "暂无摘要"}</p>{event.sourceUrl ? <a className="mt-3 inline-block text-xs font-semibold text-[var(--teal)] hover:underline" href={event.sourceUrl} target="_blank" rel="noreferrer">{event.sourceName || "查看原文"} ↗</a> : null}</div></article>) : <p className="px-5 py-10 text-center text-sm text-slate-500">暂无关联事件</p>}</div></section></div><aside className="space-y-8"><section><Heading title="元数据" /><div className="divide-y divide-[var(--line)] border-y border-[var(--line)] bg-white">{[["实体 ID", organization.entityId], ["领域", organization.analysisType || organization.entityType || "未分类"], ["可信度评分", organization.credibilityScore == null ? "暂无" : `${organization.credibilityScore}/100`], ["提及次数", String(organization.mentionCount)], ["来源数量", String(organization.sourceCount)]].map(([label, value]) => <div className="flex items-center justify-between gap-4 px-5 py-3 text-sm" key={label}><span className="text-slate-400">{label}</span><span className="text-right font-medium text-slate-700">{value}</span></div>)}</div></section><section><Heading title="领域标签" /><div className="flex flex-wrap gap-2 border-y border-[var(--line)] bg-white px-5 py-5">{tags.length ? tags.map((tag) => <span className="border border-[var(--teal)] px-2 py-1 text-xs text-[var(--teal)]" key={tag}>{tag}</span>) : <span className="text-sm text-slate-500">暂无标签</span>}</div></section>{sourcesResult.results.length ? <section><Heading title="来源网站" /><div className="divide-y divide-[var(--line)] border-y border-[var(--line)] bg-white">{sourcesResult.results.map((source) => <a className="block px-5 py-4 hover:bg-[var(--teal-soft)]" href={source.url} target="_blank" rel="noreferrer" key={source.id}><p className="text-sm font-medium text-[var(--ink)]">{source.name}</p><p className="mt-1 truncate text-xs text-slate-500">{source.url}</p></a>)}</div></section> : null}</aside></section>
    </main>
  );
}

function Heading({ title }: { title: string }) { return <h2 className="mb-3 border-b border-[var(--line)] pb-3 text-xl font-semibold text-[var(--ink)]">{title}</h2>; }
function Message({ text }: { text: string }) { return <main className="mx-auto max-w-4xl border-y border-[var(--line)] bg-white px-6 py-12 text-center text-sm text-slate-500">{text}</main>; }
