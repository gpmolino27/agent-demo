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
