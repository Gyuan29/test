import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Tabs({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("space-y-4", className)} {...props} />; }
export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("inline-flex rounded-lg bg-slate-100 p-1", className)} {...props} />; }
export function TabsTrigger({ active, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { active?: boolean }) { return <button className={cn("rounded-md px-3 py-2 text-sm font-medium text-slate-500 transition hover:text-slate-900", active && "bg-white text-slate-950 shadow-sm", className)} {...props} />; }
