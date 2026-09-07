/**
 * Hook do Next que roda uma vez quando o servidor sobe.
 * Usado pra garantir que o prompt do bot exista no Langfuse — assim um deploy
 * novo já sobe com tudo pronto, sem passo manual.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureSystemPromptExists } = await import("./lib/prompt");
  await ensureSystemPromptExists();
}
