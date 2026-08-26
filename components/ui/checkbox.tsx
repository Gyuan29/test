import type { InputHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Checkbox({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} type="checkbox" className={cn("h-4 w-4 rounded border-slate-300 text-teal-700 focus:ring-teal-500", className)} />;
}
