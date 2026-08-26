"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { EmptyState } from "@/app/ui/workbench";
import type { Organization, OrganizationSearchResponse } from "@/app/ui/types";

const initialResult: OrganizationSearchResponse = { items: [], total: 0, limit: 25, offset: 0, query: "", configured: false };

type OrganizationDirectoryProps = {
  mockResult?: OrganizationSearchResponse;
};

export function OrganizationDirectory({ mockResult }: OrganizationDirectoryProps) {
  const [draftQuery, setDraftQuery] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");
  const [core, setCore] = useState(false);
  const [result, setResult] = useState<OrganizationSearchResponse>(mockResult ?? initialResult);
  const [loading, setLoading] = useState(!mockResult);

  useEffect(() => {
    if (mockResult) {
      const normalizedQuery = query.trim().toLocaleLowerCase();
      const items = mockResult.items.filter((organization) => {
        const matchesQuery = !normalizedQuery || [
          organization.name,
          organization.description,
          organization.summary,
          organization.context,
        ].some((value) => value?.toLocaleLowerCase().includes(normalizedQuery));
        const matchesType = !type || organization.entityType === type;
        const matchesRegion = !region || organization.region === region;
        const matchesCountry = !country || organization.country === country;
        const matchesCore = !core || organization.isCoreTracking;
        return matchesQuery && matchesType && matchesRegion && matchesCountry && matchesCore;
      });
      setResult({ ...mockResult, items, total: items.length, query });
      setLoading(false);
      return;
    }

    const params = new URLSearchParams({ limit: "50" });
    if (query) params.set("q", query);
    if (type) params.set("type", type);
    if (region) params.set("region", region);
    if (country) params.set("country", country);
    if (core) params.set("core", "true");
    fetch(`/api/organizations?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => { const payload = await response.json() as { success: boolean; data?: Organization[]; pagination?: { total: number; page: number; limit: number } }; if (!response.ok || !payload.success) throw new Error("request_failed"); return { items: payload.data ?? [], total: payload.pagination?.total ?? 0, limit: payload.pagination?.limit ?? 50, offset: ((payload.pagination?.page ?? 1) - 1) * (payload.pagination?.limit ?? 50), query, configured: true }; })
      .then((nextResult) => setResult(nextResult))
      .catch(() => setResult(initialResult))
      .finally(() => setLoading(false));
    return () => undefined;
    return () => {
      alive = false;
    };
  }, [query, type, region, country, core, mockResult]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setQuery(draftQuery.trim());
  }

  function changeFilter(setter: (value: string) => void, value: string) {
    setLoading(true);
    setter(value);
  }

  return (
    <div className="space-y-7">
      <section className="border-b border-[var(--line)] pb-7">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.18em] text-[var(--teal)]">Entity directory</p>
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">机构目录</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted)]">按名称、实体类型和地域组合筛选，打开机构档案查看事件与官方来源。</p>
          </div>
          <span className="font-mono text-xs text-slate-400">{loading ? "QUERYING" : `${result.total} RESULTS`}</span>
        </div>
      </section>

      <form className="border border-[var(--line)] bg-white p-4 sm:p-5" onSubmit={submit}>
        <div className="flex flex-col gap-3 lg:flex-row">
          <label className="flex min-w-0 flex-1 items-center border border-[var(--line)] bg-[#fbfcfc] px-3 focus-within:border-[var(--teal)]">
            <span className="mr-3 font-mono text-xs text-[var(--teal)]" aria-hidden="true">/</span>
            <span className="sr-only">搜索机构名称或上下文</span>
            <input className="focus-ring min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-slate-400" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="搜索机构名称、上下文或关键词" />
          </label>
          <button className="focus-ring bg-[var(--ink)] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#263758]" type="submit">搜索</button>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect label="实体类型" value={type} onChange={(value) => changeFilter(setType, value)} options={["机构", "孵化/转化平台", "高校", "科研机构", "企业", "政府/公共机构"]} />
          <FilterSelect label="区域" value={region} onChange={(value) => changeFilter(setRegion, value)} options={["北美", "欧洲", "亚洲", "非洲", "大洋洲", "南美"]} />
          <FilterSelect label="国家" value={country} onChange={(value) => changeFilter(setCountry, value)} options={["中国", "美国", "英国", "法国", "德国", "新加坡", "印度"]} />
          <label className="flex cursor-pointer items-center gap-3 border border-[var(--line)] px-3 py-2.5 text-sm text-slate-600">
            <input className="h-4 w-4 accent-[#0f766e]" type="checkbox" checked={core} onChange={(event) => { setLoading(true); setCore(event.target.checked); }} />
            只看核心跟踪机构
          </label>
        </div>
      </form>

      <section aria-live="polite">
        {loading ? <div className="divide-y divide-[var(--line)] border-y border-[var(--line)] bg-white">{Array.from({ length: 6 }, (_, index) => <div className="animate-pulse px-5 py-5" key={index}><div className="h-4 w-1/3 bg-slate-100" /><div className="mt-3 h-3 w-2/3 bg-slate-100" /></div>)}</div> : result.items.length ? <OrganizationRows items={result.items} /> : <div className="border-y border-[var(--line)] bg-white"><EmptyState title="没有匹配的机构" detail={result.configured ? "尝试减少筛选条件或更换搜索词。" : "D1 尚未连接，当前没有可展示的数据。"} /></div>}
      </section>

      {!result.configured && !loading ? <p className="text-xs text-slate-400">搜索请求已发送至 `/api/organizations`，当前返回空数据模式。</p> : null}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: string[] }) {
  return <label className="block border border-[var(--line)] px-3 py-2"><span className="block text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{label}</span><select className="focus-ring mt-1 w-full bg-transparent text-sm text-[var(--ink)] outline-none" value={value} onChange={(event) => onChange(event.target.value)}><option value="">全部</option>{options.map((option) => <option key={option} value={option}>{option}</option>)}</select></label>;
}

function OrganizationRows({ items }: { items: Organization[] }) {
  return <div className="divide-y divide-[var(--line)] border-y border-[var(--line)] bg-white">{items.map((organization) => <Link className="focus-ring group block px-5 py-5 transition hover:bg-[#f0f8f6]" href={`/organizations/${organization.slug}`} key={organization.entityId}><div className="grid gap-4 md:grid-cols-[minmax(0,1.3fr)_0.8fr_0.8fr_auto] md:items-center"><div className="min-w-0"><div className="flex items-center gap-2"><h2 className="truncate font-semibold text-[var(--ink)] group-hover:text-[var(--teal)]">{organization.name}</h2>{organization.isCoreTracking ? <span className="shrink-0 bg-[var(--teal-soft)] px-2 py-1 text-[10px] font-bold text-[var(--teal)]">CORE</span> : null}</div><p className="mt-1 truncate text-xs text-slate-500">{organization.entityType}{organization.analysisType ? ` · ${organization.analysisType}` : ""}</p></div><Meta label="区域" value={organization.region} /><Meta label="国家" value={organization.country} /><span className="font-mono text-[11px] text-slate-400 md:text-right">{organization.entityId}</span></div></Link>)}</div>;
}

function Meta({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400">{label}</p><p className="mt-1 truncate text-xs text-slate-600">{value || "—"}</p></div>;
}
