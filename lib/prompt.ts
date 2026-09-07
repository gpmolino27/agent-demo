import type { Langfuse, TextPromptClient } from "langfuse";

/** Nome do prompt no Langfuse (Prompts → bot-system). */
export const SYSTEM_PROMPT_NAME = "bot-system";

/**
 * Usado enquanto o prompt não existir no Langfuse, ou se o Langfuse estiver
 * fora do ar — o bot nunca deve parar de responder por causa disso.
 */
export const FALLBACK_SYSTEM_PROMPT =
  "Você é um assistente útil e conciso. Responda em português salvo pedido contrário.";

export type ResolvedPrompt = {
  text: string;
  /**
   * Só vem preenchido quando o prompt veio mesmo do Langfuse. Serve pra
   * vincular a generation à versão do prompt (métricas por versão na UI);
   * com o fallback não há versão real pra vincular.
   */
  client?: TextPromptClient;
};

/**
 * Cria o prompt no Langfuse se — e somente se — ele ainda não existir.
 * Roda uma vez no boot do servidor (instrumentation.ts), então não é preciso
 * criar nada na mão nem rodar script depois de subir o app.
 *
 * Deliberadamente conservador: só escreve diante de um 404 explícito. Qualquer
 * outra resposta (200, 500, timeout, Langfuse fora do ar) não cria nada — assim
 * um erro transitório nunca gera uma versão nova que sobrescreveria, via label
 * `production`, o prompt que você editou na UI.
 */
export async function ensureSystemPromptExists(): Promise<void> {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASEURL } =
    process.env;

  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY || !LANGFUSE_BASEURL) {
    return;
  }

  const auth =
    "Basic " +
    Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString(
      "base64",
    );
  const base = LANGFUSE_BASEURL.replace(/\/+$/, "");
  const name = encodeURIComponent(SYSTEM_PROMPT_NAME);

  let existing: Response;
  try {
    existing = await fetch(
      `${base}/api/public/v2/prompts/${name}?label=production`,
      { headers: { Authorization: auth } },
    );
  } catch (err) {
    console.warn("[prompt] não deu pra consultar o Langfuse:", err);
    return;
  }

  if (existing.status !== 404) {
    if (!existing.ok) {
      console.warn(
        `[prompt] consulta retornou ${existing.status} — não vou criar nada.`,
      );
    }
    return;
  }

  try {
    const created = await fetch(`${base}/api/public/v2/prompts`, {
      method: "POST",
      headers: { Authorization: auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "text",
        name: SYSTEM_PROMPT_NAME,
        prompt: FALLBACK_SYSTEM_PROMPT,
        labels: ["production"],
        commitMessage: "Versão inicial criada automaticamente no boot do app",
      }),
    });

    if (created.ok) {
      console.log(
        `[prompt] "${SYSTEM_PROMPT_NAME}" criado no Langfuse com o label production.`,
      );
    } else {
      console.warn(
        `[prompt] falha ao criar (${created.status}): ${await created.text()}`,
      );
    }
  } catch (err) {
    console.warn("[prompt] falha ao criar o prompt:", err);
  }
}

export async function resolveSystemPrompt(
  langfuse: Langfuse | null,
): Promise<ResolvedPrompt> {
  if (!langfuse) {
    return { text: FALLBACK_SYSTEM_PROMPT };
  }

  try {
    const client = await langfuse.getPrompt(SYSTEM_PROMPT_NAME, undefined, {
      label: "production",
      cacheTtlSeconds: 300,
      fallback: FALLBACK_SYSTEM_PROMPT,
      type: "text",
    });

    return client.isFallback
      ? { text: client.prompt }
      : { text: client.prompt, client };
  } catch {
    return { text: FALLBACK_SYSTEM_PROMPT };
  }
}
