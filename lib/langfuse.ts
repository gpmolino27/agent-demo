import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

/**
 * SDK v4 do Langfuse. Diferente do v3, o tracing é OpenTelemetry: as
 * observações viram spans OTel e um LangfuseSpanProcessor os exporta via OTLP.
 *
 * Por que migramos: o Langfuse v4 recusa `trace-create`, `span-create` e
 * `generation-create` em /api/public/ingestion (o endpoint do SDK v3) quando
 * LANGFUSE_MIGRATION_V4_WRITE_MODE está no default `events_only` — só passam
 * scores. O sintoma é traiçoeiro: a UI fica em "Waiting for first trace" e o
 * erro só aparece no log de quem envia.
 */

// O v4 lê LANGFUSE_BASE_URL (com underscore); o v3 lia LANGFUSE_BASEURL.
// Aceitamos os dois pra não depender de renomear variável em produção.
function baseUrl(): string | undefined {
  return process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_BASEURL;
}

function credentials() {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY } = process.env;
  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) return null;
  return {
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: baseUrl(),
  };
}

// undefined = ainda não resolvido; null = chaves ausentes.
let processor: LangfuseSpanProcessor | null | undefined;
let client: LangfuseClient | null | undefined;

/**
 * Registra o tracer provider uma vez no processo. Sem isso, startObservation
 * cria spans que não vão a lugar nenhum — silenciosamente.
 */
export function initTracing(): LangfuseSpanProcessor | null {
  if (processor !== undefined) return processor;

  const creds = credentials();
  if (!creds) {
    processor = null;
    return null;
  }

  processor = new LangfuseSpanProcessor(creds);
  new NodeTracerProvider({ spanProcessors: [processor] }).register();

  return processor;
}

/** Cliente REST: scores e prompts. Não passa por OTLP. */
export function getLangfuse(): LangfuseClient | null {
  if (client !== undefined) return client;

  const creds = credentials();
  client = creds ? new LangfuseClient(creds) : null;
  return client;
}

/**
 * Sem tracer provider registrado (chaves ausentes), o OTel devolve um tracer
 * no-op e todo span nasce com este trace id. Guardar isso no banco criaria
 * feedback apontando pra um trace que não existe.
 */
const INVALID_TRACE_ID = "0".repeat(32);

/** Devolve null quando o trace id é o do tracer no-op. */
export function realTraceId(id: string): string | null {
  return id === INVALID_TRACE_ID ? null : id;
}

/**
 * Flush com teto de tempo. Observabilidade não pode segurar a resposta do
 * usuário quando o Langfuse está fora do ar — o export segue em background
 * depois do timeout (o servidor Next é de vida longa).
 */
export async function flushWithTimeout(ms = 1500) {
  const pending: Promise<unknown>[] = [];

  if (processor) pending.push(processor.forceFlush().catch(() => {}));
  if (client) pending.push(client.flush().catch(() => {}));
  if (pending.length === 0) return;

  await Promise.race([
    Promise.all(pending),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}
