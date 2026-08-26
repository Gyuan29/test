"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { OrganizationProfile } from "@/app/ui/types";

function formatDate(value: string) {
  if (value.toLowerCase() === "unknown") return "近期";
  if (!value) return "日期未知";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}

type OrganizationProfileViewProps = {
  mockProfile?: OrganizationProfile;
};

export function OrganizationProfileView({ mockProfile }: OrganizationProfileViewProps) {
  const { slug } = useParams<{ slug: string }>();
  const [profile, setProfile] = useState<OrganizationProfile | null>(mockProfile ?? null);
  const [loading, setLoading] = useState(!mockProfile);
  const [error, setError] = useState("");

  useEffect(() => {
    if (mockProfile) {
      setProfile(mockProfile);
      setError("");
      setLoading(false);
      return;
    }

    if (!slug) return;
    let alive = true;
    fetch(`/api/organizations/${encodeURIComponent(slug)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 404 ? "找不到这个机构档案" : "机构档案暂时不可用");
        const payload = await response.json() as { organization: OrganizationProfile["organization"]; events: OrganizationProfile["events"]; newsSources: OrganizationProfile["newsSources"] };
        return { ...payload, credibilityAnalysis: undefined } as OrganizationProfile;
      })
      .then((nextProfile) => alive && setProfile(nextProfile))
      .catch((reason: unknown) => alive && setError(reason instanceof Error ? reason.message : "机构档案暂时不可用"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    return () => {
      alive = false;
    };
  }, [slug, mockProfile]);

  if (loading) return <ProfileLoading />;
  if (error || !profile) return <div className="space-y-5"><Link className="focus-ring text-sm font-semibold text-[var(--teal)] hover:underline" href="/organizations">← 返回机构目录</Link><div className="border-y border-[var(--line)] bg-white px-5 py-12 text-center"><p className="font-semibold text-[var(--ink)]">{error || "机构档案暂时不可用"}</p><p className="mt-2 text-xs text-slate-400">请求地址：`/api/organizations/{slug}`</p></div></div>;

  const { organization, events, newsSources, credibilityAnalysis } = profile;
  return (
    <div className="space-y-8">
      <Link className="focus-ring inline-flex text-sm font-semibold text-[var(--teal)] hover:underline" href="/organizations">← 返回机构目录</Link>
      <section className="border-b border-[var(--line)] pb-8">
        <div className="flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div className="min-w-0">
            <div className="mb-3 flex flex-wrap items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-[var(--teal)]"><span>{organization.entityType}</span>{organization.isCoreTracking ? <span className="bg-[var(--teal-soft)] px-2 py-1">核心跟踪</span> : null}</div>
            <h1 className="max-w-4xl text-3xl font-semibold tracking-tight sm:text-4xl">{organization.name}</h1>
            <p className="mt-3 text-sm text-slate-500">{organization.country} · {organization.region}{organization.founded ? ` · 成立于 ${organization.founded}` : ""}</p>
          </div>
          <div className="flex shrink-0 gap-2"><Link className="focus-ring border border-[var(--line)] bg-white px-4 py-3 text-sm font-semibold text-[var(--ink)] hover:border-[var(--teal)]" href={`/chat?organization=${encodeURIComponent(organization.slug)}`}>询问 Agent</Link>{organization.websiteUrl ? <a className="focus-ring bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white hover:bg-[#263758]" href={organization.websiteUrl} rel="noreferrer" target="_blank">官方网站 ↗</a> : null}</div>
        </div>
      </section>

      <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="space-y-8">
          <div><SectionHeading eyebrow="Profile brief" title="机构摘要" /> <div className="border-y border-[var(--line)] bg-white px-5 py-5 text-sm leading-7 text-slate-600">{organization.summary || organization.context || "暂无摘要。该档案已连接 API，可在 Agent 对话中继续补充研究问题。"}</div></div>
          <div><SectionHeading eyebrow="Public timeline" title="事件时间线" /> <div className="border-y border-[var(--line)] bg-white">{events.length ? events.map((event) => <article className="grid gap-3 border-b border-[var(--line)] px-5 py-5 last:border-0 sm:grid-cols-[130px_1fr]" key={event.id}><p className="font-mono text-[11px] text-[var(--coral)]">{formatDate(event.eventDate)}</p><div><h2 className="font-medium text-[var(--ink)]">{event.title}</h2>{event.summary ? <p className="mt-2 text-xs leading-5 text-slate-500">{event.summary}</p> : null}{event.sourceUrl ? <a className="focus-ring mt-3 inline-block text-xs font-semibold text-[var(--teal)] hover:underline" href={event.sourceUrl} rel="noreferrer" target="_blank">{event.sourceName || "查看来源"} ↗</a> : null}</div></article>) : <div className="px-5 py-10 text-center text-sm text-slate-500">暂无公开事件</div>}</div></div>
        </div>
        <aside className="space-y-8">
          {credibilityAnalysis ? <div><SectionHeading eyebrow="Credibility" title="可信度分析" /><div className="border-y border-[var(--line)] bg-white"><div className="flex items-end justify-between gap-4 px-5 py-5"><p className="text-sm leading-6 text-slate-600">{credibilityAnalysis.summary}</p><p className="shrink-0 font-mono text-2xl font-semibold text-[var(--teal)]">{credibilityAnalysis.score}<span className="text-xs text-slate-400">/100</span></p></div><div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">{credibilityAnalysis.factors.map((factor) => <div className="flex items-center justify-between gap-4 px-5 py-3 text-xs" key={factor.label}><span className="text-slate-400">{factor.label}</span><span className="font-medium text-slate-600">{factor.value}</span></div>)}</div></div></div> : null}
          <div><SectionHeading eyebrow="Record" title="档案信息" /><div className="divide-y divide-[var(--line)] border-y border-[var(--line)] bg-white">{[["实体 ID", organization.entityId], ["审计类型", organization.analysisType || "—"], ["提及次数", String(organization.mentionCount)], ["位置置信度", organization.locationConfidence || "—"], ["来源文档", organization.sourceDocument || "—"]].map(([label, value]) => <div className="flex items-start justify-between gap-4 px-5 py-3 text-xs" key={label}><span className="text-slate-400">{label}</span><span className="text-right font-medium text-slate-600">{value}</span></div>)}</div></div>
          <div><SectionHeading eyebrow="Verified sources" title="新闻源" /><div className="divide-y divide-[var(--line)] border-y border-[var(--line)] bg-white">{newsSources.length ? newsSources.map((source) => <a className="focus-ring block px-5 py-4 hover:bg-[#f0f8f6]" href={source.url} key={source.id} rel="noreferrer" target="_blank"><div className="flex items-center justify-between gap-3"><span className="truncate text-sm font-medium text-[var(--ink)]">{source.name}</span><span className="font-mono text-[10px] text-slate-400">{source.last_fetch_status || "pending"}</span></div><p className="mt-2 truncate text-xs text-slate-400">{source.url}</p></a>) : <div className="px-5 py-8 text-sm text-slate-500">暂无已验证新闻源</div>}</div></div>
        </aside>
      </section>
    </div>
  );
}

function SectionHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="mb-4 border-b border-[var(--line)] pb-3"><p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">{eyebrow}</p><h2 className="mt-1 text-xl font-semibold text-[var(--ink)]">{title}</h2></div>;
}

function ProfileLoading() {
  return <div className="animate-pulse space-y-8"><div className="h-4 w-32 bg-slate-200" /><div className="border-b border-[var(--line)] pb-8"><div className="h-10 w-2/3 bg-slate-200" /><div className="mt-4 h-4 w-1/3 bg-slate-200" /></div><div className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]"><div className="h-80 bg-white" /><div className="h-64 bg-white" /></div></div>;
}
