import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "secondary" | "outline" | "danger";

export function Button({ className, variant = "default", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button className={cn("inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition hover:-translate-y-px focus:outline-none focus:ring-2 focus:ring-teal-500/30 disabled:pointer-events-none disabled:opacity-50", variant === "default" && "bg-slate-950 text-white shadow-sm hover:bg-slate-800", variant === "secondary" && "bg-teal-50 text-teal-800 hover:bg-teal-100", variant === "outline" && "border border-slate-200 bg-white text-slate-700 hover:border-teal-300 hover:text-teal-800", variant === "danger" && "border border-red-200 bg-red-50 text-red-700 hover:bg-red-100", className)} {...props} />;
}
