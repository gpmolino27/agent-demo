/**
 * Hook do Next que roda uma vez quando o servidor sobe.
 * Usado pra garantir que o prompt do bot exista no Langfuse — assim um deploy
 * novo já sobe com tudo pronto, sem passo manual.
 *
 * Não importe lib/knowledge daqui: o Next compila este arquivo também para o
 * edge runtime, que não resolve fs/path, e o better-sqlite3 quebra o build. O
 * índice da base é construído (e logado) na primeira busca.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { ensureSystemPromptExists } = await import("./lib/prompt");
  await ensureSystemPromptExists();
}
