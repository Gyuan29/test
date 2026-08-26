import { Suspense } from "react";
import { ChatPanel } from "@/app/ui/chat-panel";

export default function ChatPage() {
  return <Suspense fallback={<div className="h-96 animate-pulse bg-white" />}><ChatPanel /></Suspense>;
}
