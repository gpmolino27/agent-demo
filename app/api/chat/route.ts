import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { propagateAttributes, startActiveObservation, startObservation } from "@langfuse/tracing";
import { addMessage, conversationExists, createConversation } from "@/lib/db";
import {
  flushWithTimeout,
  getLangfuse,
  initTracing,
  realTraceId,
} from "@/lib/langfuse";
import { searchKnowledge } from "@/lib/knowledge";
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

  // Registra o tracer provider (memoizado). Precisa vir antes de qualquer
  // startObservation, senão os spans são criados e descartados em silêncio.
  const tracing = initTracing();
  const langfuse = getLangfuse();

  // Prompt versionado no Langfuse (com fallback local se não existir/estiver fora).
  const systemPrompt = await resolveSystemPrompt(langfuse);

  const question = lastUserMessage?.content ?? "";
  const cid = conversationId;

  const run = async (
    traceId: string | null,
  ): Promise<{ res: NextResponse; reply: string }> => {
    // Busca na base de conhecimento (knowledge/*.md) os trechos da pergunta.
    const retrieval = startObservation(
      "knowledge-retrieval",
      { input: { query: question } },
      { asType: "retriever" },
    );
    const hits = searchKnowledge(question);
    // O texto dos trechos vai pro span de propósito: é o que um avaliador
    // LLM-as-a-judge precisa ver pra dizer se a resposta ficou fundamentada.
    retrieval.update({
      output: hits.map((hit) => ({
        heading: hit.heading,
        score: Number(hit.score.toFixed(2)),
        body: hit.body,
      })),
    });
    retrieval.end();

    // Cada trecho vira um document block com citations: o modelo responde
    // ancorado neles e devolve qual trecho sustentou cada frase.
    const documents: Anthropic.DocumentBlockParam[] = hits.map((hit) => ({
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: `${hit.heading}\n\n${hit.body}`,
      },
      title: `${hit.doc} — ${hit.heading}`,
      citations: { enabled: true },
    }));

    const generation = startObservation(
      "claude-completion",
      {
        model: MODEL,
        input: messages,
        // Vincula a generation à versão do prompt → métricas por versão na UI.
        prompt: systemPrompt.link,
        metadata: { retrievedChunks: hits.length },
      },
      { asType: "generation" },
    );

    try {
      const apiMessages: Anthropic.MessageParam[] = messages.map((m, i) => {
        const isLastUser = m.role === "user" && i === messages.length - 1;
        if (!isLastUser || documents.length === 0) {
          return { role: m.role, content: m.content };
        }
        // Documentos antes do texto: é a ordem que a API espera.
        return {
          role: m.role,
          content: [...documents, { type: "text" as const, text: m.content }],
        };
      });

      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 2048,
        system: systemPrompt.text,
        messages: apiMessages,
      });

      const textBlocks = response.content.filter(
        (block): block is Anthropic.TextBlock => block.type === "text",
      );
      const reply = textBlocks.map((block) => block.text).join("");

      // Seções efetivamente citadas — não as recuperadas. É a diferença entre
      // "isto estava no contexto" e "isto sustentou a resposta".
      const sources = [
        ...new Set(
          textBlocks
            .flatMap((block) => block.citations ?? [])
            // TextCitation também cobre resultados de web search, que não têm
            // document_title — aqui só existem citações dos nossos documentos.
            .filter(
              (citation): citation is Anthropic.CitationCharLocation =>
                citation.type === "char_location",
            )
            .map((citation) => citation.document_title)
            .filter((title): title is string => Boolean(title)),
        ),
      ];

      generation.update({
        output: reply,
        usageDetails: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
      });
      generation.end();

      const messageId = addMessage(cid, "assistant", reply, traceId, sources);

      return {
        reply,
        res: NextResponse.json({
          reply,
          conversationId: cid,
          messageId,
          sources,
          traceId,
        }),
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Erro ao chamar o modelo.";

      generation.update({ level: "ERROR", statusMessage: message });
      generation.end();

      return {
        reply: message,
        res: NextResponse.json({ error: message }, { status: 500 }),
      };
    }
  };

  try {
    // sessionId agrupa todos os traces de uma mesma conversa no Langfuse.
    return await propagateAttributes(
      { sessionId: cid, traceName: "chat-message" },
      async () =>
        await startActiveObservation("chat-message", async (root) => {
          root.update({ input: messages });
          const { res, reply } = await run(realTraceId(root.traceId));
          root.update({ output: reply });
          return res;
        }),
    );
  } finally {
    if (tracing || langfuse) {
      await flushWithTimeout();
    }
  }
}
