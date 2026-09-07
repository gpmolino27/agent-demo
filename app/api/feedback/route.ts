import { NextRequest, NextResponse } from "next/server";
import { getMessage, setMessageFeedback } from "@/lib/db";
import { getLangfuse, flushWithTimeout } from "@/lib/langfuse";

export const runtime = "nodejs";

/** Nome do score no Langfuse — média = % de respostas aprovadas. */
const SCORE_NAME = "user-feedback";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const messageId = Number(body?.messageId);
  const value = body?.value;

  if (!Number.isInteger(messageId)) {
    return NextResponse.json({ error: "messageId inválido." }, { status: 400 });
  }
  if (value !== 1 && value !== 0 && value !== null) {
    return NextResponse.json(
      { error: "value deve ser 1 (👍), 0 (👎) ou null." },
      { status: 400 },
    );
  }

  const message = getMessage(messageId);
  if (!message) {
    return NextResponse.json(
      { error: "Mensagem não encontrada." },
      { status: 404 },
    );
  }

  setMessageFeedback(messageId, value);

  // O score só vai pro Langfuse quando há trace — mensagens antigas (de antes
  // desta feature) não têm trace_id, mas o feedback local continua valendo.
  if (value !== null && message.traceId) {
    const langfuse = getLangfuse();
    if (langfuse) {
      langfuse.score({
        traceId: message.traceId,
        name: SCORE_NAME,
        value,
        dataType: "NUMERIC",
      });
      await flushWithTimeout(langfuse);
    }
  }

  return NextResponse.json({ ok: true });
}
