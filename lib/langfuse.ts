import { Langfuse } from "langfuse";

/**
 * Devolve null quando as chaves não estão configuradas — nesse caso o app
 * funciona normalmente, só sem enviar nada pro Langfuse.
 */
export function createLangfuse(): Langfuse | null {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASEURL } =
    process.env;

  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
    return null;
  }

  return new Langfuse({
    publicKey: LANGFUSE_PUBLIC_KEY,
    secretKey: LANGFUSE_SECRET_KEY,
    baseUrl: LANGFUSE_BASEURL,
  });
}

/**
 * Flush com teto de tempo. O SDK faz retry com backoff e leva ~9s pra desistir
 * quando o Langfuse está fora do ar — observabilidade não pode segurar a
 * resposta do usuário por isso. O envio segue em background depois do timeout
 * (o servidor Next é de vida longa, então normalmente completa mesmo assim).
 */
export async function flushWithTimeout(langfuse: Langfuse, ms = 1500) {
  await Promise.race([
    langfuse.flushAsync().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, ms)),
  ]);
}
