"use client";

import { useState } from "react";

type ChatMessage = {
  role: "user" | "assistant" | "error";
  content: string;
};

export default function Home() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function sendMessage() {
    const text = input.trim();
    if (!text || loading) return;

    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next
            .filter((m) => m.role !== "error")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Falha ao chamar o agente");
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.reply as string },
      ]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content: err instanceof Error ? err.message : "Erro inesperado",
        },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="page">
      <div className="header">
        <h1>Agent Demo</h1>
        <p>Claude + Langfuse — cada mensagem gera um trace no Langfuse.</p>
      </div>

      <div className="messages">
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            {m.content}
          </div>
        ))}
        {loading && <div className="message assistant">Pensando…</div>}
      </div>

      <div className="composer">
        <textarea
          rows={2}
          value={input}
          placeholder="Digite uma mensagem…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          Enviar
        </button>
      </div>
    </div>
  );
}
