"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { formatDate } from "@/lib/utils";

type Role = "admin";
type ProgressType = "search" | "event";
type Organization = { entityId: string; name: string; description: string | null; websiteUrl: string | null; lastSearchedAt?: string | null; searchStatus?: "pending" | "success" | "failed" | null };
type EventItem = { id: string; title: string; organizationName?: string | null; eventDate: string };
type Progress = { taskId: string | null; total: number; processed: number; success: number; failed: number; currentInstitution: string | null; status: "starting" | "running" | "completed" | "failed"; message?: string };

function progressText(value: Progress, event = false): string {
  if (value.status === "starting") return "正在初始化任务...";
  if (value.total === 0 && value.status === "running") return "正在检查待更新机构...";
  if (value.total === 0 && value.status === "completed") return "✅ 检查完成：当前没有需要更新的机构（如需强制更新，请勾选‘强制重新搜索’）";
  if (value.status === "failed") return value.message || "后台搜索任务失败";
  if (value.status === "completed") return event ? "事件搜索完成！" : "更新完成！";
  return `${event ? "正在搜索事件" : "正在搜索"} ${value.processed}/${value.total || "..."}... (成功: ${value.success}, 失败: ${value.failed})`;
}

const activeProgress = (value: Progress | null): boolean => Boolean(value && (value.status === "starting" || value.status === "running"));
const shouldPollProgress = (value: Progress | null): boolean => Boolean(value && value.status != null && value.status !== "completed" && value.status !== "failed");

export default function AdminPage() {
  const [role, setRole] = useState<Role | null>(null);
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [message, setMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [eventProgress, setEventProgress] = useState<Progress | null>(null);
  const [searchSkipHours, setSearchSkipHours] = useState("24");
  const [searchForce, setSearchForce] = useState(false);
  const [limit, setLimit] = useState("");
  const [eventSkipHours, setEventSkipHours] = useState("24");
  const [eventForce, setEventForce] = useState(false);
  const [eventLimit, setEventLimit] = useState("");
  const [eventDays, setEventDays] = useState("365");
  const [customEventDays, setCustomEventDays] = useState("365");
  const [resettingProgress, setResettingProgress] = useState<ProgressType | null>(null);
  const [orgDialog, setOrgDialog] = useState(false);
  const [descriptionEdit, setDescriptionEdit] = useState<{ id: string; value: string } | null>(null);
  const [newOrg, setNewOrg] = useState({ name: "", description: "", websiteUrl: "" });
  const headers = { "content-type": "application/json" };

  async function load(): Promise<void> {
    const [orgResponse, eventResponse] = await Promise.all([fetch("/api/admin/organizations", { headers, cache: "no-store" }), fetch("/api/admin/events", { headers, cache: "no-store" })]);
    if (!orgResponse.ok || !eventResponse.ok) throw new Error("无法读取管理数据");
    setOrganizations((await orgResponse.json() as { data?: Organization[] }).data || []);
    setEvents((await eventResponse.json() as { data?: EventItem[] }).data || []);
  }

  async function recoverProgress(): Promise<void> {
    const [searchResponse, eventResponse] = await Promise.all([fetch("/api/admin/search-progress", { headers, cache: "no-store" }), fetch("/api/admin/event-search-progress", { headers, cache: "no-store" })]);
    if (searchResponse.ok) setProgress(await searchResponse.json() as Progress);
    if (eventResponse.ok) setEventProgress(await eventResponse.json() as Progress);
  }

  async function resetProgress(type: ProgressType): Promise<void> {
    if (role !== "admin") return;
    setResettingProgress(type);
    setErrorMessage("");
    try {
      const response = await fetch("/api/admin/reset-progress", { method: "POST", headers, body: JSON.stringify({ type }) });
      const result = await response.json() as { success?: boolean; error?: string };
      if (!response.ok || result.success !== true) {
        setErrorMessage(result.error || "重置任务失败");
        return;
      }
      if (type === "search") setProgress(null);
      else setEventProgress(null);
      setMessage(type === "search" ? "机构搜索任务已重置" : "事件搜索任务已重置");
    } catch {
      setErrorMessage("重置任务失败");
    } finally {
      setResettingProgress(null);
    }
  }

  async function verifyToken(): Promise<void> {
    try {
      const response = await fetch("/api/admin/verify-token", { cache: "no-store" });
      const body = await response.json() as { valid?: boolean; role?: Role | null };
      if (!body.valid || body.role !== "admin") { setRole(null); setErrorMessage("当前登录用户不具有管理员权限"); return; }
      setRole("admin"); setErrorMessage("");
      await load(); await recoverProgress();
      setMessage("当前会话具有管理员权限");
    } catch { setRole(null); setErrorMessage("管理员权限验证失败"); }
  }

  async function logout(): Promise<void> { await fetch("/api/auth/logout", { method: "POST" }); setRole(null); setProgress(null); setEventProgress(null); setMessage("已退出登录"); }

  useEffect(() => { void verifyToken(); }, []);

  async function triggerSearch(): Promise<void> {
    setErrorMessage("");
    const trimmed = limit.trim();
    const parsedLimit = trimmed ? Number(trimmed) : null;
    const skipHours = Number(searchSkipHours);
    if (!Number.isInteger(skipHours) || skipHours < 0) { setErrorMessage("跳过小时必须是非负整数"); return; }
    if (trimmed && (!Number.isInteger(parsedLimit) || parsedLimit === null || parsedLimit < 1)) { setErrorMessage("Limit 必须是正整数，或留空运行全部机构"); return; }
    const body = { skipHours, force: searchForce, ...(parsedLimit === null ? {} : { limit: parsedLimit }) };
    const response = await fetch("/api/admin/trigger-search", { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as { taskId?: string; error?: string };
    if (!response.ok) { setErrorMessage(result.error || "搜索任务启动失败"); return; }
    setProgress({ taskId: result.taskId || null, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "starting" }); setMessage("搜索任务已启动");
  }

  async function triggerEventSearch(): Promise<void> {
    setErrorMessage("");
    const skipHours = Number(eventSkipHours);
    const trimmed = eventLimit.trim();
    const parsedLimit = trimmed ? Number(trimmed) : null;
    const days = Number(eventDays === "custom" ? customEventDays : eventDays);
    if (!Number.isInteger(skipHours) || skipHours < 0) { setErrorMessage("事件搜索跳过小时必须是非负整数"); return; }
    if (!Number.isInteger(days) || days < 1) { setErrorMessage("事件搜索时间范围必须是正整数天数"); return; }
    if (trimmed && (!Number.isInteger(parsedLimit) || parsedLimit === null || parsedLimit < 1)) { setErrorMessage("事件搜索 Limit 必须是正整数，或留空运行全部机构"); return; }
    const body = { skipHours, days, force: eventForce, ...(parsedLimit === null ? {} : { limit: parsedLimit }) };
    const response = await fetch("/api/admin/trigger-event-search", { method: "POST", headers, body: JSON.stringify(body) });
    const result = await response.json() as { taskId?: string; error?: string };
    if (!response.ok) { setErrorMessage(result.error || "事件搜索任务启动失败"); return; }
    setEventProgress({ taskId: result.taskId || null, total: 0, processed: 0, success: 0, failed: 0, currentInstitution: null, status: "starting" }); setMessage("事件搜索任务已启动");
  }

  useEffect(() => {
    if (!shouldPollProgress(progress) || role !== "admin") return undefined;
    let cancelled = false;
    const poll = async () => { const response = await fetch("/api/admin/search-progress", { headers, cache: "no-store" }); if (!response.ok || cancelled) return; const next = await response.json() as Progress; if (!cancelled) setProgress(next); };
    void poll(); const timer = window.setInterval(() => void poll(), 2000); return () => { cancelled = true; window.clearInterval(timer); };
  }, [progress?.status, role]);
  useEffect(() => {
    if (!shouldPollProgress(eventProgress) || role !== "admin") return undefined;
    let cancelled = false;
    const poll = async () => { const response = await fetch("/api/admin/event-search-progress", { headers, cache: "no-store" }); if (!response.ok || cancelled) return; const next = await response.json() as Progress; if (!cancelled) setEventProgress(next); };
    void poll(); const timer = window.setInterval(() => void poll(), 2000); return () => { cancelled = true; window.clearInterval(timer); };
  }, [eventProgress?.status, role]);

  async function createOrganization(event: FormEvent) { event.preventDefault(); const response = await fetch("/api/admin/organizations", { method: "POST", headers, body: JSON.stringify(newOrg) }); if (!response.ok) { setErrorMessage("新增机构失败"); return; } setNewOrg({ name: "", description: "", websiteUrl: "" }); setOrgDialog(false); await load(); setMessage("机构已新增"); }
  async function saveDescription(event: FormEvent) { event.preventDefault(); if (!descriptionEdit) return; const response = await fetch("/api/admin/organizations", { method: "PUT", headers, body: JSON.stringify({ entityId: descriptionEdit.id, name: "unchanged", description: descriptionEdit.value }) }); if (!response.ok) { setErrorMessage("简介保存失败"); return; } setDescriptionEdit(null); await load(); setMessage("简介已保存"); }

  return <main className="space-y-6">
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-teal-700">Administration</p><h1 className="mt-2 text-3xl font-semibold text-slate-950">管理后台</h1></div><div className="flex flex-wrap items-center gap-2"><Button variant="outline" onClick={() => void verifyToken()}>刷新权限</Button><Button variant="outline" onClick={() => void logout()}>退出登录</Button>{role === "admin" ? <Badge className="bg-green-50 text-green-700">管理员</Badge> : null}</div></div>
    {errorMessage ? <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{errorMessage}</p> : null}{message ? <p role="status" className="rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">{message}</p> : null}
    <Card><CardHeader className="flex items-center justify-between"><CardTitle>数据更新策略</CardTitle><Button variant="outline" className="h-8 px-3 text-xs" disabled={role !== "admin" || resettingProgress !== null} onClick={() => void resetProgress("search")}>重置任务</Button></CardHeader><CardContent className="space-y-3"><div className="flex flex-wrap items-center gap-2"><label htmlFor="search-skip-hours">跳过小时</label><Input id="search-skip-hours" className="w-24" type="number" min={0} value={searchSkipHours} onChange={(event) => setSearchSkipHours(event.target.value)} /><label className="flex items-center gap-2"><input type="checkbox" checked={searchForce} onChange={(event) => setSearchForce(event.target.checked)} />强制重新搜索</label><Input className="w-32" type="number" min={1} inputMode="numeric" value={limit} onChange={(event) => setLimit(event.target.value)} placeholder="留空则全量运行" aria-label="搜索数量限制" /></div><Button disabled={role !== "admin" || activeProgress(progress)} onClick={() => void triggerSearch()}>一键自动更新</Button>{progress ? <div className="space-y-2"><div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-teal-600 transition-all" style={{ width: `${progress.total ? Math.min(100, progress.processed / progress.total * 100) : 0}%` }} /></div><p className={progress.status === "failed" ? "text-sm text-red-700" : progress.status === "completed" && progress.total === 0 ? "text-sm text-green-700" : "text-sm text-slate-600"}>{progressText(progress)}</p></div> : null}</CardContent></Card>
    <Card><CardHeader className="flex items-center justify-between"><CardTitle>事件/新闻搜索策略</CardTitle><div className="flex items-center gap-2"><Button variant="outline" className="h-8 px-3 text-xs" onClick={() => void recoverProgress()}>刷新状态</Button><Button variant="outline" className="h-8 px-3 text-xs" disabled={role !== "admin" || resettingProgress !== null} onClick={() => void resetProgress("event")}>重置任务</Button></div></CardHeader><CardContent className="space-y-3"><div className="flex flex-wrap items-center gap-2"><label htmlFor="event-skip-hours">跳过小时</label><Input id="event-skip-hours" className="w-24" type="number" min={0} value={eventSkipHours} onChange={(event) => setEventSkipHours(event.target.value)} /><label htmlFor="event-days">时间范围</label><select id="event-days" className="h-10 border border-slate-200 bg-white px-2 text-sm" value={eventDays} onChange={(event) => setEventDays(event.target.value)}><option value="30">近1月</option><option value="90">近3月</option><option value="180">近半年</option><option value="365">近1年</option><option value="custom">自定义</option></select>{eventDays === "custom" ? <Input className="w-24" type="number" min={1} value={customEventDays} onChange={(event) => setCustomEventDays(event.target.value)} aria-label="自定义天数" /> : null}<label className="flex items-center gap-2"><input type="checkbox" checked={eventForce} onChange={(event) => setEventForce(event.target.checked)} />强制重搜</label><Input className="w-32" type="number" min={1} inputMode="numeric" value={eventLimit} onChange={(event) => setEventLimit(event.target.value)} placeholder="留空则全量运行" aria-label="事件搜索数量限制" /></div><Button disabled={role !== "admin" || activeProgress(eventProgress)} onClick={() => void triggerEventSearch()}>立即触发事件搜索</Button>{eventProgress ? <div className="space-y-2"><div className="h-3 overflow-hidden rounded-full bg-slate-100"><div className="h-full bg-teal-600 transition-all" style={{ width: `${eventProgress.total ? Math.min(100, eventProgress.processed / eventProgress.total * 100) : 0}%` }} /></div><p className={eventProgress.status === "starting" ? "flex items-center gap-2 text-sm text-slate-600" : eventProgress.status === "failed" ? "text-sm text-red-700" : eventProgress.status === "completed" && eventProgress.total === 0 ? "text-sm text-green-700" : "text-sm text-slate-600"}>{eventProgress.status === "starting" ? <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-teal-600" aria-hidden="true" /> : null}{progressText(eventProgress, true)}</p></div> : null}</CardContent></Card>
    <Card><CardHeader className="flex items-center justify-between"><CardTitle>机构管理</CardTitle><Button disabled={role !== "admin"} onClick={() => setOrgDialog(true)}>新增机构</Button></CardHeader><CardContent className="p-0"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-3">名称</th><th className="p-3">官网</th><th className="p-3">最后搜索时间</th><th className="p-3">状态</th><th className="p-3 text-right">操作</th></tr></thead><tbody>{organizations.map((item) => <tr className="border-b" key={item.entityId}><td className="p-3 font-semibold">{item.name}</td><td className="p-3">{item.websiteUrl || "未登记"}</td><td className="p-3 text-xs text-slate-500">{item.lastSearchedAt ? `${formatDate(item.lastSearchedAt)} (本地时间)` : "未搜索"}</td><td className="p-3"><Badge className={item.searchStatus === "failed" ? "bg-red-50 text-red-700" : item.searchStatus === "success" ? "bg-green-50 text-green-700" : "bg-slate-100 text-slate-600"}>{item.searchStatus === "failed" ? "未找到官网" : item.searchStatus === "success" ? "已验证" : "待搜索"}</Badge></td><td className="p-3 text-right">{role === "admin" ? <Button variant="outline" onClick={() => setDescriptionEdit({ id: item.entityId, value: item.description || "" })}>编辑简介</Button> : null}</td></tr>)}</tbody></table></CardContent></Card>
    <Card><CardHeader><CardTitle>事件管理</CardTitle></CardHeader><CardContent className="p-0"><table className="w-full text-sm"><tbody>{events.map((item) => <tr className="border-b" key={item.id}><td className="p-3">{item.title}</td><td className="p-3">{item.organizationName || "未分类"}</td><td className="p-3">{formatDate(item.eventDate, false)}</td></tr>)}</tbody></table></CardContent></Card>
    <Dialog open={orgDialog} title="新增机构" onClose={() => setOrgDialog(false)}><form className="space-y-3" onSubmit={(event) => void createOrganization(event)}><Input required placeholder="机构名称" value={newOrg.name} onChange={(event) => setNewOrg({ ...newOrg, name: event.target.value })} /><Input type="url" placeholder="官网 URL（可选）" value={newOrg.websiteUrl} onChange={(event) => setNewOrg({ ...newOrg, websiteUrl: event.target.value })} /><textarea className="min-h-24 w-full rounded-lg border p-3 text-sm" placeholder="简介" value={newOrg.description} onChange={(event) => setNewOrg({ ...newOrg, description: event.target.value })} /><Button type="submit">保存</Button></form></Dialog>
    <Dialog open={Boolean(descriptionEdit)} title="编辑机构简介" onClose={() => setDescriptionEdit(null)}><form className="space-y-3" onSubmit={(event) => void saveDescription(event)}><textarea className="min-h-32 w-full rounded-lg border p-3 text-sm" value={descriptionEdit?.value || ""} onChange={(event) => setDescriptionEdit(descriptionEdit ? { ...descriptionEdit, value: event.target.value } : null)} /><Button type="submit">保存简介</Button></form></Dialog>
  </main>;
}
