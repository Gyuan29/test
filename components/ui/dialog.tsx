import type { ReactNode } from "react";

export function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 p-4" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="w-full max-w-lg rounded-xl border border-slate-200 bg-white shadow-2xl"><div className="flex items-center justify-between border-b border-slate-100 px-5 py-4"><h2 className="font-semibold text-slate-950">{title}</h2><button type="button" className="rounded-md px-2 py-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} aria-label="关闭">×</button></div><div className="p-5">{children}</div></div></div>;
}
