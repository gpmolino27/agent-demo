import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { addMessage, conversationExists, createConversation } from "@/lib/db";
import { createLangfuse, flushWithTimeout } from "@/lib/langfuse";
import { resolveSystemPrompt } from "@/lib/prompt";

export const runtime = "nodejs";

const MODEL = "claude-sonnet-5";

type IncomingMessage = { role: "user" | "assistant"; content: string };

function makeTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (!trimmed) return "Nova conversa";
  return trimmed.length > 48 ? `${trimmed.slice(0, 48)}…` : trimmed;
}

export async function POST(req: NextRequest) {
  const { ANTHROPIC_API_KEY } = process.env;

  if (!ANTHROPIC_API_KEY) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY não configurada no servidor." },
      { status: 500 },
    );
  }

  let body: { messages?: IncomingMessage[]; conversationId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido." }, { status: 400 });
  }

  const messages = body.messages ?? [];
  if (messages.length === 0) {
    return NextResponse.json(
      { error: "Envie ao menos uma mensagem." },
      { status: 400 },
    );
  }

  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === "user");

  let conversationId = body.conversationId;
  if (!conversationId || !conversationExists(conversationId)) {
    const conversation = createConversation(
      makeTitle(lastUserMessage?.content ?? ""),
    );
    conversationId = conversation.id;
  }

  if (lastUserMessage) {
    addMessage(conversationId, "user", lastUserMessage.content);
  }

  const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const langfuse = createLangfuse();

  // Prompt versionado no Langfuse (com fallback local se não existir/estiver fora).
  const systemPrompt = await resolveSystemPrompt(langfuse);

  // sessionId agrupa todos os traces de uma mesma conversa no Langfuse.
  const trace = langfuse?.trace({
    name: "chat-message",
    sessionId: conversationId,
    input: messages,
  });

  const generation = trace?.generation({
    name: "claude-completion",
    model: MODEL,
    input: messages,
    // Vincula a generation à versão do prompt → métricas por versão na UI.
    prompt: systemPrompt.client,
  });

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: systemPrompt.text,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const reply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    const messageId = addMessage(
      conversationId,
      "assistant",
      reply,
      trace?.id ?? null,
    );

    generation?.end({
      output: reply,
      usage: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    });
    trace?.update({ output: reply });

    return NextResponse.json({
      reply,
      conversationId,
      messageId,
      traceId: trace?.id ?? null,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Erro ao chamar o modelo.";

    generation?.end({ level: "ERROR", statusMessage: message });
    trace?.update({ output: message });

    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (langfuse) {
      await flushWithTimeout(langfuse);
    }
  }
}
