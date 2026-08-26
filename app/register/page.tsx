"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(normalizedEmail)) { setError("Please enter a valid email address."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirmation) { setError("Passwords do not match."); return; }
    setLoading(true); setError("");
    try {
      const response = await fetch("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: normalizedEmail, password }) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error === "email_already_registered" ? "That email is already registered." : "Registration failed.");
      }
      window.location.assign("/");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Registration failed."); } finally { setLoading(false); }
  }

  return <main className="flex min-h-screen items-center justify-center bg-[var(--paper)] px-5"><form className="w-full max-w-sm border border-[var(--line)] bg-white p-7" onSubmit={submit}><p className="text-xs font-bold uppercase tracking-[0.18em] text-[var(--teal)]">Institution Intel</p><h1 className="mt-3 text-2xl font-semibold text-[var(--ink)]">Create account</h1><label className="mt-7 block text-sm font-medium" htmlFor="register-email">Email</label><Input className="mt-2" id="register-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /><label className="mt-4 block text-sm font-medium" htmlFor="register-password">Password</label><Input className="mt-2" id="register-password" type="password" autoComplete="new-password" minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required /><label className="mt-4 block text-sm font-medium" htmlFor="register-confirmation">Confirm password</label><Input className="mt-2" id="register-confirmation" type="password" autoComplete="new-password" minLength={6} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />{error ? <p className="mt-4 text-sm text-red-700" role="alert">{error}</p> : null}<Button className="mt-6 w-full" disabled={loading} type="submit">{loading ? "Registering..." : "Register and sign in"}</Button><p className="mt-5 text-center text-sm text-slate-500">{"\u5df2\u6709\u8d26\u53f7\uff1f"} <Link className="font-semibold text-[var(--teal)] hover:underline" href="/login">{"\u53bb\u767b\u5f55"}</Link></p></form></main>;
}
