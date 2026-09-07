import { Langfuse } from "langfuse";

// undefined = ainda não resolvido; null = chaves ausentes.
let client: Langfuse | null | undefined;

/**
 * Cliente único do processo. Devolve null quando as chaves não estão
 * configuradas — nesse caso o app funciona normalmente, só sem enviar nada.
 *
 * Precisa ser singleton: um cliente por request cria uma fila e um timer de
 * flush novos a cada chamada, então o envio que não coube no teto de tempo
 * abaixo ficava pendurado num cliente que ninguém mais toca. Com um só, a fila
 * é compartilhada e o flush da próxima request carrega o que sobrou da
 * anterior.
 */
export function getLangfuse(): Langfuse | null {
  if (client !== undefined) return client;

  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASEURL } =
    process.env;

  client =
    LANGFUSE_PUBLIC_KEY && LANGFUSE_SECRET_KEY
      ? new Langfuse({
          publicKey: LANGFUSE_PUBLIC_KEY,
          secretKey: LANGFUSE_SECRET_KEY,
          baseUrl: LANGFUSE_BASEURL,
        })
      : null;

  return client;
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
