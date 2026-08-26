import type { HTMLAttributes, TdHTMLAttributes, ThHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Table({ className, ...props }: HTMLAttributes<HTMLTableElement>) { return <div className="overflow-x-auto"><table className={cn("w-full text-left text-sm", className)} {...props} /></div>; }
export function TableHeader({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) { return <thead className={cn("border-b border-slate-200 bg-slate-50/80 text-xs uppercase tracking-wide text-slate-500", className)} {...props} />; }
export function TableBody({ className, ...props }: HTMLAttributes<HTMLTableSectionElement>) { return <tbody className={cn("divide-y divide-slate-100", className)} {...props} />; }
export function TableRow({ className, ...props }: HTMLAttributes<HTMLTableRowElement>) { return <tr className={cn("transition-colors hover:bg-teal-50/40", className)} {...props} />; }
export function TableHead({ className, ...props }: ThHTMLAttributes<HTMLTableCellElement>) { return <th className={cn("px-4 py-3 font-semibold", className)} {...props} />; }
export function TableCell({ className, ...props }: TdHTMLAttributes<HTMLTableCellElement>) { return <td className={cn("px-4 py-3 align-top", className)} {...props} />; }
