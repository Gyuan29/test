"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type Organization = {
  id: number | string;
  entityId?: string;
  slug?: string;
  name: string;
  description?: string | null;
  summary?: string | null;
  category?: string | null;
  location?: string | null;
};

type ApiResponse<T> = {
  success: boolean;
  data?: T;
  error?: string;
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage: boolean;
    hasPreviousPage: boolean;
  };
};

const PAGE_LIMIT = 20;

export default function OrganizationsPage() {
  const [search, setSearch] = useState("");
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<ApiResponse<Organization[]>["pagination"]>();

  useEffect(() => {
    const controller = new AbortController();

    async function loadOrganizations() {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch(
          `/api/organizations?search=${encodeURIComponent(search.trim())}&page=${page}&limit=${PAGE_LIMIT}`,
          { signal: controller.signal },
        );
        const payload = (await response.json()) as ApiResponse<Organization[]>;

        if (!response.ok || !payload.success || !Array.isArray(payload.data)) {
          throw new Error(payload.error ?? "无法加载机构列表");
        }

        setOrganizations(payload.data);
        setPagination(payload.pagination);
      } catch (requestError) {
        if (controller.signal.aborted) {
          return;
        }

        setOrganizations([]);
        setError(
          requestError instanceof Error ? requestError.message : "无法加载机构列表",
        );
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      }
    }

    void loadOrganizations();

    return () => controller.abort();
  }, [search, page, reloadKey]);

  return (
    <main className="mx-auto min-h-screen max-w-6xl px-6 py-10">
      <div className="flex flex-col gap-5 border-b border-slate-200 pb-7 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-medium text-sky-700">机构库</p>
          <h1 className="mt-1 text-3xl font-semibold text-slate-950">机构列表</h1>
        </div>
        <label className="w-full sm:max-w-sm">
          <span className="sr-only">搜索机构</span>
          <input
            type="search"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            placeholder="搜索机构名称或简介"
            className="h-10 w-full border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:border-sky-600 focus:ring-2 focus:ring-sky-100"
          />
        </label>
      </div>

      {error ? (
        <section className="mt-8 border border-red-200 bg-red-50 p-5 text-sm text-red-800" role="alert">
          <p>{error}</p>
          <button
            type="button"
            onClick={() => setReloadKey((value) => value + 1)}
            className="mt-3 border border-red-300 px-3 py-1.5 font-medium text-red-900 hover:bg-red-100"
          >
            重新加载
          </button>
        </section>
      ) : null}

      {isLoading ? (
        <p className="mt-8 text-sm text-slate-500" role="status">
          正在加载机构...
        </p>
      ) : null}

      {!isLoading && !error && organizations.length === 0 ? (
        <p className="mt-8 text-sm text-slate-500">
          {search ? "没有找到匹配的机构。" : "暂无机构数据。"}
        </p>
      ) : null}

      {organizations.length > 0 ? (
        <ul className="mt-8 grid gap-4 md:grid-cols-2">
          {organizations.map((organization) => (
            <li key={organization.entityId || organization.slug || organization.id} className="list-none">
              <Link className="block cursor-pointer border border-slate-200 bg-white p-5 shadow-sm transition-all hover:border-[var(--teal)] hover:bg-[var(--teal-soft)] hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-[var(--teal)] focus:ring-inset" href={`/organizations/${organization.slug || organization.entityId || organization.id}`}>
              <div className="flex items-start justify-between gap-4">
                <h2 className="text-lg font-semibold text-slate-950">{organization.name}</h2>
                {organization.category ? (
                  <span className="shrink-0 border border-sky-200 bg-sky-50 px-2 py-1 text-xs font-medium text-sky-800">
                    {organization.category}
                  </span>
                ) : null}
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                {truncate(organization.description ?? organization.summary ?? "暂无机构简介。", 80)}
              </p>
              {organization.location ? (
                <p className="mt-4 text-xs text-slate-500">{organization.location}</p>
              ) : null}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}

      {!isLoading && !error && pagination && pagination.totalPages > 1 ? (
        <nav className="mt-8 flex items-center justify-between border-t border-slate-200 pt-5" aria-label="机构目录分页">
          <button
            type="button"
            onClick={() => setPage((current) => Math.max(1, current - 1))}
            disabled={!pagination.hasPreviousPage}
            className="border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            上一页
          </button>
          <span className="text-sm text-slate-500">
            第 {pagination.page} / {pagination.totalPages} 页
          </span>
          <button
            type="button"
            onClick={() => setPage((current) => current + 1)}
            disabled={!pagination.hasNextPage}
            className="border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一页
          </button>
        </nav>
      ) : null}
    </main>
  );
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}
