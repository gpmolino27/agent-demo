/**
 * Cria (ou versiona) o prompt do bot no Langfuse com o label "production".
 *
 * Uso:
 *   LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... LANGFUSE_BASEURL=... \
 *     node scripts/seed-prompt.mjs
 *
 * Rodar de novo cria uma nova versão e move o label "production" pra ela.
 * Depois da primeira vez, dá pra editar direto na UI do Langfuse
 * (Prompts → bot-system) sem precisar de deploy.
 */
import { Langfuse } from "langfuse";

const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASEURL } =
  process.env;

if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY) {
  console.error(
    "Faltam LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY no ambiente.",
  );
  process.exit(1);
}

const langfuse = new Langfuse({
  publicKey: LANGFUSE_PUBLIC_KEY,
  secretKey: LANGFUSE_SECRET_KEY,
  baseUrl: LANGFUSE_BASEURL,
});

const prompt = await langfuse.createPrompt({
  name: "bot-system",
  prompt: "Você é um assistente útil e conciso. Responda em português salvo pedido contrário.",
  labels: ["production"],
  commitMessage: "Prompt inicial (igual ao fallback do código)",
});

await langfuse.flushAsync();

console.log(`Prompt "${prompt.name}" v${prompt.version} criado com label production.`);
