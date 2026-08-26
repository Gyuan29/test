"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError("");
    try {
      const response = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
      if (!response.ok) throw new Error("Invalid email or password.");
      window.location.assign("/");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Login failed."); } finally { setLoading(false); }
  }
  return <main className="flex min-h-screen items-center justify-center bg-[var(--paper)] px-5"><form className="w-full max-w-sm border border-[var(--line)] bg-white p-7" onSubmit={submit}><p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--teal)]">Institution Intel</p><h1 className="mt-3 text-2xl font-semibold text-[var(--ink)]">Sign in</h1><label className="mt-7 block text-sm font-medium" htmlFor="email">Email</label><Input className="mt-2" id="email" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /><label className="mt-4 block text-sm font-medium" htmlFor="password">Password</label><Input className="mt-2" id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />{error ? <p className="mt-4 text-sm text-red-700" role="alert">{error}</p> : null}<Button className="mt-6 w-full" disabled={loading} type="submit">{loading ? "Signing in..." : "Sign in"}</Button><p className="mt-5 text-center text-sm text-slate-500">{"\u8fd8\u6ca1\u6709\u8d26\u53f7\uff1f"} <Link className="font-semibold text-[var(--teal)] hover:underline" href="/register">{"\u53bb\u6ce8\u518c"}</Link></p></form></main>;
}
