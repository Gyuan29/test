"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navigation = [
  { href: "/", label: "工作台", mark: "01" },
  { href: "/organizations", label: "机构目录", mark: "02" },
  { href: "/events", label: "事件档案", mark: "03" },
  { href: "/chat", label: "Agent 对话", mark: "04" },
];

function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === "/login" || pathname === "/register") return <>{children}</>;
  const current = navigation.find((item) => isActive(pathname, item.href));
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.assign("/login");
  }

  return (
    <div className="min-h-screen bg-[var(--paper)]">
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 flex-col border-r border-[var(--line)] bg-[var(--ink)] text-white lg:flex">
        <div className="border-b border-white/10 px-7 py-7">
          <Link href="/" className="focus-ring block" aria-label="返回机构情报台工作台">
            <p className="text-[11px] font-bold uppercase tracking-[0.24em] text-[#8ad8d0]">Institution Intel</p>
            <p className="mt-2 text-xl font-semibold tracking-tight">机构情报台</p>
          </Link>
        </div>
        <nav className="flex-1 px-4 py-6" aria-label="主导航">
          <p className="px-3 pb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-white/40">Workspace</p>
          <div className="space-y-1">
            {navigation.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  className={`focus-ring flex items-center gap-3 border-l-2 px-3 py-3 text-sm transition ${
                    active
                      ? "border-[#8ad8d0] bg-white/10 text-white"
                      : "border-transparent text-white/60 hover:bg-white/5 hover:text-white"
                  }`}
                  href={item.href}
                  key={item.href}
                >
                  <span className="w-6 font-mono text-[10px] text-[#8ad8d0]">{item.mark}</span>
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
        <div className="border-t border-white/10 px-7 py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center bg-[#d8eeea] text-xs font-bold text-[var(--ink)]">LI</span>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Research workspace</p>
              <button className="truncate text-xs text-white/45 hover:text-white" onClick={logout} type="button">退出登录</button>
            </div>
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 border-b border-[var(--line)] bg-[rgba(245,247,248,0.94)] backdrop-blur">
          <div className="mx-auto flex h-16 max-w-[1500px] items-center justify-between px-5 sm:px-8">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--muted)]">{current?.label ?? "机构情报台"}</p>
              <p className="mt-1 text-xs text-slate-500">公开信号 · 持续沉淀 · 可追溯分析</p>
            </div>
            <div className="flex items-center gap-3 text-xs text-slate-500">
              <span className="hidden items-center gap-2 sm:flex"><span className="h-2 w-2 bg-[#0f9b8e]" /> 数据服务在线</span>
              <span className="h-8 w-px bg-[var(--line)]" />
              <span className="font-mono text-[11px]">D1 / LOCAL</span>
            </div>
          </div>
          <nav className="flex gap-1 overflow-x-auto border-t border-[var(--line)] px-5 py-2 lg:hidden" aria-label="移动端主导航">
            {navigation.map((item) => (
              <Link className={`focus-ring shrink-0 px-3 py-2 text-xs ${isActive(pathname, item.href) ? "bg-[var(--ink)] text-white" : "text-slate-500"}`} href={item.href} key={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
        </header>
        <main className="mx-auto min-h-[calc(100vh-4rem)] max-w-[1500px] px-5 py-8 sm:px-8 lg:py-10">{children}</main>
      </div>
    </div>
  );
}
