import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "@/app/ui/app-shell";

export const metadata: Metadata = {
  title: "机构情报台",
  description: "面向研究与投资团队的机构情报工作台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
