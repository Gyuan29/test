"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Insights, Organization } from "@/app/ui/types";

const emptyInsights: Insights = { organizationCount: 0, eventCount: 0, recentEvents: [], configured: false };

export type WorkbenchMockStats = {
  organizationTotal: number;
  dailyCollections: number;
  activeSessions: number;
  systemHealth: number;
};

type WorkbenchProps = {
  mockInsights?: Insights;
  mockOrganizations?: Organization[];
  mockStats?: WorkbenchMockStats;
};

function formatDate(value: string) {
  if (value.toLowerCase() === "unknown") return "近期";
  if (!value) return "未记录";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium" }).format(date);
}

export function Workbench({ mockInsights, mockOrganizations, mockStats }: WorkbenchProps) {
  const [insights, setInsights] = useState<Insights>(mockInsights ?? emptyInsights);
  const [organizations, setOrganizations] = useState<Organization[]>(mockOrganizations ?? []);
  const [loading, setLoading] = useState(!mockInsights || !mockOrganizations);

  useEffect(() => {
    if (mockInsights && mockOrganizations) {
      setInsights(mockInsights);
      setOrganizations(mockOrganizations);
      setLoading(false);
      return;
    }

    let alive = true;
    Promise.all([
      fetch("/api/insights", { cache: "no-store" }).then(async (response) => { const payload = await response.json() as { success: boolean; data?: Insights }; if (!response.ok || !payload.success || !payload.data) throw new Error("无法加载工作台"); return payload.data; }),
      fetch("/api/organizations?limit=6&core=true", { cache: "no-store" }).then(async (response) => { const payload = await response.json() as { success: boolean; data?: Organization[] }; if (!response.ok || !payload.success) throw new Error("无法加载机构"); return { items: payload.data ?? [] } as OrganizationSearchResponse; }),
    ])
      .then(([nextInsights, nextOrganizations]) => {
        if (!alive) return;
        setInsights(nextInsights);
        setOrganizations(nextOrganizations.items ?? []);
      })
      .catch(() => undefined)
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    return () => {
      alive = false;
    };
  }, [mockInsights, mockOrganizations]);

  const overviewStats = mockStats
    ? [
        ["机构总数", mockStats.organizationTotal, "已纳入本地预览数据"],
        ["今日新增采集", mockStats.dailyCollections, "模拟的今日更新记录"],
        ["活跃会话", mockStats.activeSessions, "当前工作台会话数"],
        ["系统健康度", `${mockStats.systemHealth}%`, "本地预览运行正常"],
      ]
    : [
        ["机构总数", insights.organizationCount, "已通过质量筛选"],
        ["时间线事件", insights.eventCount, "最近公开信号"],
        ["数据状态", insights.configured ? "在线" : "待连接", insights.configured ? "D1 durable storage" : "本地空数据模式"],
      ];

  return (
    <div className="space-y-8">
      <section className="flex flex-col justify-between gap-5 border-b border-[var(--line)] pb-8 sm:flex-row sm:items-end">
        <div>
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-[var(--teal)]">Research overview</p>
          <h1 className="text-3xl font-semibold tracking-tight text-[var(--ink)] sm:text-4xl">今天，先看变化。</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">从机构目录、公开事件和新闻源状态开始，快速定位值得深入的信号。</p>
        </div>
        <Link className="focus-ring inline-flex w-fit items-center gap-2 bg-[var(--ink)] px-4 py-3 text-sm font-semibold text-white transition hover:bg-[#263758]" href="/organizations">
          打开机构目录 <span aria-hidden="true">→</span>
        </Link>
      </section>

      <section className="grid gap-px border border-[var(--line)] bg-[var(--line)] sm:grid-cols-2 lg:grid-cols-4" aria-label="工作台概览">
        {overviewStats.map(([label, value, hint]) => (
          <div className="bg-white px-5 py-5" key={String(label)}>
            <p className="text-xs font-medium text-[var(--muted)]">{label}</p>
            <p className="mt-3 text-2xl font-semibold tracking-tight text-[var(--ink)]">{loading ? "—" : value}</p>
            <p className="mt-2 text-xs text-slate-400">{hint}</p>
          </div>
        ))}
      </section>

      <section className="grid gap-8 lg:grid-cols-[1.15fr_0.85fr]">
        <div>
          <div className="mb-4 flex items-end justify-between border-b border-[var(--line)] pb-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--teal)]">Priority watchlist</p>
              <h2 className="mt-1 text-xl font-semibold">核心机构</h2>
            </div>
            <Link className="focus-ring text-xs font-semibold text-[var(--teal)] hover:underline" href="/organizations?core=true">查看全部</Link>
          </div>
          <div className="divide-y divide-[var(--line)] border-y border-[var(--line)] bg-white">
            {loading ? <LoadingRows count={4} /> : organizations.length ? organizations.map((organization) => (
              <Link className="focus-ring group block px-5 py-4 transition hover:bg-[#f0f8f6]" href={`/organizations/${organization.slug}`} key={organization.entityId}>
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-[var(--ink)] group-hover:text-[var(--teal)]">{organization.name}</p>
                    <p className="mt-1 truncate text-xs text-slate-500">{organization.entityType} · {organization.country} / {organization.region}</p>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-slate-400">{organization.entityId}</span>
                </div>
              </Link>
            )) : <EmptyState title="暂无机构数据" detail="连接 D1 后，核心机构会显示在这里。" />}
          </div>
        </div>

        <div>
          <div className="mb-4 border-b border-[var(--line)] pb-3">
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--coral)]">Latest signals</p>
            <h2 className="mt-1 text-xl font-semibold">近期事件</h2>
          </div>
          <div className="border-y border-[var(--line)] bg-white">
            {loading ? <LoadingRows count={3} /> : insights.recentEvents.length ? insights.recentEvents.slice(0, 5).map((event) => (
              <div className="border-b border-[var(--line)] px-5 py-4 last:border-0" key={event.id}>
                <p className="text-[11px] font-mono text-[var(--coral)]">{formatDate(event.eventDate)}</p>
                <p className="mt-2 font-medium text-[var(--ink)]">{event.title}</p>
                {event.summary ? <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">{event.summary}</p> : null}
              </div>
            )) : <EmptyState title="暂无近期事件" detail="采集公开新闻源后，事件会出现在这里。" />}
          </div>
        </div>
      </section>

      {!insights.configured && !loading ? <div className="border-l-2 border-[var(--amber)] bg-[#fff8e7] px-4 py-3 text-sm text-[#854d0e]">当前处于本地空数据模式。页面已经连接 API，配置 D1 后会自动显示真实数据。</div> : null}
    </div>
  );
}

function LoadingRows({ count }: { count: number }) {
  return <div className="divide-y divide-[var(--line)]">{Array.from({ length: count }, (_, index) => <div className="animate-pulse px-5 py-5" key={index}><div className="h-3 w-2/5 bg-slate-100" /><div className="mt-3 h-3 w-3/5 bg-slate-100" /></div>)}</div>;
}

export function EmptyState({ title, detail }: { title: string; detail: string }) {
  return <div className="px-5 py-10 text-center"><p className="font-medium text-slate-600">{title}</p><p className="mt-2 text-xs text-slate-400">{detail}</p></div>;
}
