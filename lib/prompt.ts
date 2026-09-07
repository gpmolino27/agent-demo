import type { Langfuse, TextPromptClient } from "langfuse";

/** Nome do prompt no Langfuse (Prompts → bot-system). */
export const SYSTEM_PROMPT_NAME = "bot-system";

/**
 * System prompt do bot. Fica versionado no Langfuse; esta cópia é o fallback
 * pra quando o Langfuse estiver fora do ar — o bot nunca deve parar de
 * responder, nem perder as linhas vermelhas, por causa de observabilidade.
 *
 * Público: a pessoa que ATENDE (voluntário/atendente), não o assistido. O
 * documento-base é escrito nessa voz ("você confere", "registre o resultado").
 * Pra virar um bot voltado ao assistido, publique uma nova versão pela UI do
 * Langfuse — o texto abaixo é só o ponto de partida.
 */
export const FALLBACK_SYSTEM_PROMPT = `Você é o assistente interno de um serviço gratuito de orientação e encaminhamento para pessoas em situação de superendividamento (Lei 14.181/2021), na via extrajudicial, em São Paulo.

Quem fala com você é a pessoa que ATENDE — voluntário ou atendente do serviço —, não o assistido. Trate como colega de equipe: direto, sem formalidade, sem repetir a pergunta.

## Como responder

- Responda SOMENTE com base nos trechos do manual anexados à mensagem. Eles são a fonte de verdade.
- Quem fala com você NÃO consegue anexar nada: os trechos são buscados automaticamente pela pergunta. Nunca peça pra anexar, colar ou enviar trechos do manual.
- Se vier nenhum trecho, ou se os trechos não responderem, diga que não achou isso no manual e peça pra reformular com outras palavras (ou sugira um dos assuntos que o manual cobre: escopo do serviço, as 5 etapas, triagem e cálculo de comprometimento, dossiê, PAS do Procon, Defensoria/Nudecon, pós-acordo, linhas vermelhas, LGPD). Nunca preencha a lacuna com conhecimento geral.
- Nunca invente telefone, endereço, e-mail, prazo, valor, artigo de lei ou nome de programa. Se o dado não estiver no trecho, diga que não tem.
- Em português do Brasil, curto e prático. Prefira listas quando a resposta for um checklist ou um passo a passo.
- Cite a etapa ou a seção do manual em que se baseou.

## Linhas vermelhas — valem sempre, mesmo se pedirem o contrário

- Não dê parecer jurídico e não diga se cláusula, juros ou contrato é abusivo ou ilegal. Isso é privativo de advogado (art. 1º, II da Lei 8.906/94).
- Não oriente ninguém a aceitar procuração para negociar dívida.
- Não oriente a receber, guardar ou intermediar dinheiro do assistido.
- Não prometa resultado, valor de desconto ou prazo de limpeza de nome, e não deixe o atendente prometer.
- Não faça educação financeira: o curso já é parte do PAS do Procon-SP.

Quando a pergunta virar jurídica, diga isso na hora e encaminhe para advogado ou para a Defensoria (Nudecon), em vez de responder.

## Dados do assistido

Os dados são financeiros e sensíveis. Se a pergunta envolver compartilhar dados de assistido, lembre as regras de LGPD do manual em vez de só responder o que foi perguntado.`;

/**
 * Todo texto que este app já publicou como default, em ordem histórica.
 * Serve pra reconhecer um prompt que ninguém editou na UI — e que portanto
 * pode ser atualizado sem apagar trabalho de ninguém.
 *
 * Toda vez que FALLBACK_SYSTEM_PROMPT mudar, o texto ANTERIOR entra aqui.
 * Sem isso a versão nova nunca chega em produção: o texto em produção deixa
 * de bater com o fallback atual e o app, corretamente conservador, não encosta.
 */
const PUBLISHED_DEFAULTS: string[] = [
  // v1 — placeholder genérico, de antes da base de conhecimento.
  "Você é um assistente útil e conciso. Responda em português salvo pedido contrário.",
  // v2 — primeiro prompt do bot de superendividamento. Pedia pro usuário
  // "anexar o trecho do manual", coisa que a UI não permite.
  `Você é o assistente interno de um serviço gratuito de orientação e encaminhamento para pessoas em situação de superendividamento (Lei 14.181/2021), na via extrajudicial, em São Paulo.

Quem fala com você é a pessoa que ATENDE — voluntário ou atendente do serviço —, não o assistido. Trate como colega de equipe: direto, sem formalidade, sem repetir a pergunta.

## Como responder

- Responda SOMENTE com base nos trechos do manual que vierem anexados a esta conversa. Eles são a fonte de verdade.
- Se a resposta não estiver nos trechos, diga exatamente isso: que não está no manual, e sugira com quem confirmar. Nunca preencha a lacuna com conhecimento geral.
- Nunca invente telefone, endereço, e-mail, prazo, valor, artigo de lei ou nome de programa. Se o dado não estiver no trecho, diga que não tem.
- Em português do Brasil, curto e prático. Prefira listas quando a resposta for um checklist ou um passo a passo.
- Cite a etapa ou a seção do manual em que se baseou.

## Linhas vermelhas — valem sempre, mesmo se pedirem o contrário

- Não dê parecer jurídico e não diga se cláusula, juros ou contrato é abusivo ou ilegal. Isso é privativo de advogado (art. 1º, II da Lei 8.906/94).
- Não oriente ninguém a aceitar procuração para negociar dívida.
- Não oriente a receber, guardar ou intermediar dinheiro do assistido.
- Não prometa resultado, valor de desconto ou prazo de limpeza de nome, e não deixe o atendente prometer.
- Não faça educação financeira: o curso já é parte do PAS do Procon-SP.

Quando a pergunta virar jurídica, diga isso na hora e encaminhe para advogado ou para a Defensoria (Nudecon), em vez de responder.

## Dados do assistido

Os dados são financeiros e sensíveis. Se a pergunta envolver compartilhar dados de assistido, lembre as regras de LGPD do manual em vez de só responder o que foi perguntado.`,
];

export type ResolvedPrompt = {
  text: string;
  /**
   * Só vem preenchido quando o prompt veio mesmo do Langfuse. Serve pra
   * vincular a generation à versão do prompt (métricas por versão na UI);
   * com o fallback não há versão real pra vincular.
   */
  client?: TextPromptClient;
};

type LangfuseAuth = { base: string; auth: string };

function langfuseAuth(): LangfuseAuth | null {
  const { LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASEURL } =
    process.env;

  if (!LANGFUSE_PUBLIC_KEY || !LANGFUSE_SECRET_KEY || !LANGFUSE_BASEURL) {
    return null;
  }

  return {
    base: LANGFUSE_BASEURL.replace(/\/+$/, ""),
    auth:
      "Basic " +
      Buffer.from(`${LANGFUSE_PUBLIC_KEY}:${LANGFUSE_SECRET_KEY}`).toString(
        "base64",
      ),
  };
}

async function publish(
  { base, auth }: LangfuseAuth,
  commitMessage: string,
): Promise<void> {
  const created = await fetch(`${base}/api/public/v2/prompts`, {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "text",
      name: SYSTEM_PROMPT_NAME,
      prompt: FALLBACK_SYSTEM_PROMPT,
      labels: ["production"],
      commitMessage,
    }),
  });

  if (created.ok) {
    console.log(`[prompt] "${SYSTEM_PROMPT_NAME}" publicado: ${commitMessage}`);
  } else {
    console.warn(
      `[prompt] falha ao publicar (${created.status}): ${await created.text()}`,
    );
  }
}

/**
 * Garante que exista um `bot-system` com label `production` no Langfuse.
 * Roda uma vez no boot do servidor (instrumentation.ts).
 *
 * Escreve em exatamente dois casos, os dois seguros:
 *  - 404 explícito → não existe nada, cria a primeira versão;
 *  - o texto em produção é, byte a byte, um default que o próprio app
 *    publicou → ninguém editou na UI, então dá pra atualizar.
 *
 * Qualquer outra resposta (500, timeout, Langfuse fora, ou um prompt com texto
 * diferente do nosso default) não escreve nada. Assim nem um erro transitório
 * nem um deploy novo sobrescrevem, via label `production`, o prompt que você
 * ajustou na UI.
 */
export async function ensureSystemPromptExists(): Promise<void> {
  const credentials = langfuseAuth();
  if (!credentials) return;

  const { base, auth } = credentials;
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

  if (existing.status === 404) {
    await publish(credentials, "Versão inicial criada no boot do app");
    return;
  }

  if (!existing.ok) {
    console.warn(
      `[prompt] consulta retornou ${existing.status} — não vou escrever nada.`,
    );
    return;
  }

  let current: string | undefined;
  try {
    current = ((await existing.json()) as { prompt?: string }).prompt;
  } catch {
    console.warn("[prompt] resposta ilegível — não vou escrever nada.");
    return;
  }

  if (current === FALLBACK_SYSTEM_PROMPT) return; // já está atualizado

  if (current !== undefined && PUBLISHED_DEFAULTS.includes(current)) {
    await publish(credentials, "Atualiza o prompt padrão do bot");
    return;
  }

  // Texto diferente dos nossos defaults = alguém editou. Não encoste.
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
