"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type ChatMessage = {
  role: "user" | "assistant" | "error";
  content: string;
};

type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: number;
};

export default function Home() {
  const router = useRouter();
  const [conversations, setConversations] = useState<ConversationSummary[]>(
    [],
  );
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const loadConversations = useCallback(async () => {
    const res = await fetch("/api/conversations");
    if (res.ok) {
      const data = await res.json();
      setConversations(data.conversations);
    }
  }, []);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  async function openConversation(id: string) {
    setConversationId(id);
    setSidebarOpen(false);
    const res = await fetch(`/api/conversations/${id}`);
    if (res.ok) {
      const data = await res.json();
      setMessages(
        data.messages.map((m: { role: string; content: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        })),
      );
    }
  }

  function startNewConversation() {
    setConversationId(null);
    setMessages([]);
    setSidebarOpen(false);
  }

  async function handleLogout() {
    await fetch("/api/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

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
          conversationId,
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

      if (!conversationId && data.conversationId) {
        setConversationId(data.conversationId as string);
      }

      loadConversations();
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
    <div className="layout">
      <div className="mobile-topbar">
        <button
          className="menu-toggle"
          onClick={() => setSidebarOpen(true)}
          aria-label="Abrir menu de conversas"
        >
          ☰
        </button>
        <span className="mobile-title">Agent Demo</span>
      </div>

      {sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <aside className={`sidebar ${sidebarOpen ? "open" : ""}`}>
        <div className="sidebar-header">
          <button className="new-chat" onClick={startNewConversation}>
            + Nova conversa
          </button>
          <button
            className="sidebar-close"
            onClick={() => setSidebarOpen(false)}
            aria-label="Fechar menu"
          >
            ✕
          </button>
        </div>

        <div className="conversation-list">
          {conversations.map((c) => (
            <button
              key={c.id}
              className={`conversation-item ${c.id === conversationId ? "active" : ""}`}
              onClick={() => openConversation(c.id)}
              title={c.title}
            >
              {c.title}
            </button>
          ))}
        </div>

        <button className="logout" onClick={handleLogout}>
          Sair
        </button>
      </aside>

      <div className="page">
        <div className="header">
          <h1>Agent Demo</h1>
          <p>Claude + Langfuse — cada conversa vira uma sessão de traces.</p>
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
    </div>
  );
}
