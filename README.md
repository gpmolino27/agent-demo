# Agent Demo

Assistente interno de um serviço gratuito de orientação e encaminhamento para
pessoas em situação de **superendividamento** (Lei 14.181/2021), na via
extrajudicial, em São Paulo.

App web em Next.js + TypeScript. O bot responde **a partir do manual de
atendimento** (`knowledge/`), cita a seção em que se baseou, e envia cada troca
como um trace para o [Langfuse](https://github.com/gpmolino27/langfuse-selfhost)
self-hosted. Tem login (usuário único) e histórico persistido em SQLite.

> **Quem conversa com o bot é a pessoa que atende** (voluntário/atendente), não
> o assistido — é a voz em que o manual é escrito ("você confere", "registre o
> resultado"). Para virar um bot voltado ao assistido, publique outra versão do
> prompt pela UI do Langfuse; nada no código precisa mudar.

O bot **não** dá parecer jurídico, não opina sobre legalidade de cláusula ou
juros, e encaminha para advogado ou Defensoria quando a pergunta vira jurídica.
Essas linhas vermelhas estão no system prompt e também no manual indexado.

## Como funciona

- **Login** — usuário único definido por variáveis de ambiente
  (`AUTH_EMAIL`/`AUTH_PASSWORD`). `app/api/login/route.ts` valida as
  credenciais (comparação em tempo constante) e emite um cookie httpOnly
  assinado (JWT via `jose`, `lib/auth.ts`). `middleware.ts` protege todas as
  rotas (páginas e API) exceto `/login` e `/api/login`, redirecionando para
  o login quando o cookie é inválido/ausente.
- **Histórico de conversas** — `lib/db.ts` usa `better-sqlite3` para
  persistir `conversations` e `messages` num arquivo SQLite. A sidebar em
  `app/page.tsx` lista as conversas (`GET /api/conversations`) e carrega o
  histórico de uma delas (`GET /api/conversations/[id]`) ao clicar.
- **Base de conhecimento (RAG)** — os `.md` em `knowledge/` são a fonte de
  verdade. `lib/knowledge.ts` quebra cada arquivo em seções (`##`), indexa em
  **FTS5** num SQLite em memória e busca por BM25 com o heading pesando 3x o
  corpo. Sem embeddings e sem serviço externo: a base tem alguns KB e o índice
  é reconstruído no boot, então atualizar a base é **editar o `.md` e fazer
  deploy** — sem migração, sem estado velho no volume.
  Detalhes que importam: a query é normalizada (minúsculas, sem acento, sem
  stopwords do português) pra casar com o tokenizer `unicode61
  remove_diacritics 2`; e trechos que pontuam abaixo de 15% do melhor
  resultado são descartados, senão qualquer palavra em comum arrasta seções
  irrelevantes pro contexto — que é o que faz o modelo responder fora da fonte.
- **Chat + Langfuse** — `app/api/chat/route.ts` (Node runtime):
  1. cria a conversa no SQLite (se for nova) e salva a mensagem do usuário;
  2. busca o system prompt no Langfuse (`lib/prompt.ts`);
  3. cria um `trace` no Langfuse com `sessionId = conversationId` — assim
     todas as trocas de uma mesma conversa aparecem agrupadas como uma
     *Session* no Langfuse;
  4. busca os trechos do manual e registra a recuperação como um **span**
     `knowledge-retrieval` no trace, com o texto dos trechos — é o que um
     avaliador LLM-as-a-judge precisa ver pra dizer se a resposta ficou
     fundamentada;
  5. manda os trechos como `document` blocks com `citations: {enabled: true}`
     e abre uma `generation` vinculada à versão do prompt;
  6. salva a resposta no SQLite (com o `traceId` e as seções citadas) e fecha
     a `generation` com output e uso de tokens;
  7. dá `flush` no cliente do Langfuse antes de responder — com teto de
     tempo (`flushWithTimeout`), porque o SDK leva ~9s pra desistir quando o
     Langfuse está fora, e observabilidade não pode segurar a resposta.

  Só a mensagem **atual** recebe documentos; o histórico vai como texto puro,
  pra não reenviar contexto a cada turno.
- **Citações** — as fontes exibidas embaixo da resposta são as que o modelo
  **citou**, não as que foram recuperadas. É a diferença entre "isto estava no
  contexto" e "isto sustentou a resposta".
- **Prompt versionado** — o system prompt mora no Langfuse
  (Prompts → `bot-system`, label `production`), buscado com cache de 5 min.
  Dá pra ajustar a personalidade do bot pela UI **sem novo deploy**. Se o
  prompt não existir ou o Langfuse estiver fora, o app usa o fallback em
  `lib/prompt.ts` e continua respondendo.
- **Feedback do usuário** — 👍/👎 embaixo de cada resposta
  (`app/api/feedback/route.ts`) vira um score `user-feedback` no Langfuse
  ligado ao trace daquela resposta, e fica salvo no SQLite pra UI lembrar
  depois do reload. Clicar de novo no mesmo botão remove a avaliação.

Se `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` não estiverem configuradas, o
chat funciona normalmente só sem enviar traces.

- **PWA (instalável)** — `public/manifest.webmanifest` + ícones em
  `public/icons/` + `public/sw.js` (service worker mínimo, cacheia só
  assets estáticos — páginas e chamadas de API sempre vão pra rede, já que
  são autenticadas/dinâmicas). `app/register-sw.tsx` registra o service
  worker no carregamento. `middleware.ts` libera essas três rotas mesmo sem
  login, senão o navegador não consegue ler o manifest/ícones antes do
  usuário entrar. Com isso o navegador oferece "Instalar app" / "Adicionar
  à tela inicial", abrindo em janela própria (`display: standalone`).

## Rodando localmente

```bash
npm install
cp .env.example .env.local
# edite .env.local: ANTHROPIC_API_KEY, AUTH_EMAIL/AUTH_PASSWORD,
# AUTH_SESSION_SECRET (openssl rand -hex 32) e as chaves do Langfuse
npm run dev
```

Abra http://localhost:3000 — você será redirecionado para `/login`.

### Obtendo as chaves do Langfuse

1. Acesse seu Langfuse self-hosted e faça login.
2. Abra o projeto (ex: "Default Project") → **Settings → API Keys**.
3. Crie um novo par de chaves e copie `Public Key` e `Secret Key` para o
   `.env.local` (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`).
4. `LANGFUSE_BASEURL` é a URL do seu Langfuse (ex:
   `https://langfuse-web-production-e419.up.railway.app`).

### Atualizando a base de conhecimento

Edite os `.md` em `knowledge/`, commite e faça deploy. Não há passo de
indexação: o índice é reconstruído sozinho quando o servidor sobe.

Um `##` = um trecho recuperável, e o título do `##` é o que aparece como fonte
na resposta — então **escreva headings que digam o assunto** ("Linhas
vermelhas", "Etapa 2 — Dossiê"), não "Seção 3". Seção acima de 1800 caracteres
é quebrada por parágrafo, repetindo o heading.

### O prompt no Langfuse

Não precisa criar nada na mão: no boot do servidor (`instrumentation.ts`) o
app garante que exista um `bot-system` com label `production`.

Ele escreve em exatamente dois casos, os dois seguros:

- **404 explícito** — não existe nada ainda, cria a primeira versão;
- o texto em produção é, **byte a byte**, um default que o próprio app
  publicou — ninguém editou na UI, então dá pra atualizar.

Qualquer outra resposta (500, timeout, Langfuse fora, ou um prompt com texto
diferente dos nossos defaults) **não escreve nada**. Assim nem um erro
transitório nem um deploy novo sobrescrevem, via label `production`, o prompt
que você ajustou na UI.

Depois disso, editar o prompt na UI (nova versão com o label `production`)
muda o comportamento do bot em até 5 minutos, **sem deploy**.

Se preferir criar/versionar manualmente:

```bash
LANGFUSE_PUBLIC_KEY=... LANGFUSE_SECRET_KEY=... LANGFUSE_BASEURL=... \
  npm run seed:prompt
```

## Deploy no Railway

1. Crie um novo projeto no Railway e conecte este repositório
   (`gpmolino27/agent-demo`) via GitHub — o Railway detecta Next.js
   automaticamente (Railpack) e roda `npm install && npm run build` /
   `npm start`.
2. **Adicione um volume** ao serviço, montado em `/data` (Settings →
   Volumes) — sem isso o histórico de conversas se perde a cada deploy,
   já que o SQLite fica no filesystem do container.
3. Configure as variáveis de ambiente do serviço:
   - `ANTHROPIC_API_KEY`
   - `LANGFUSE_PUBLIC_KEY`
   - `LANGFUSE_SECRET_KEY`
   - `LANGFUSE_BASEURL`
   - `AUTH_EMAIL` / `AUTH_PASSWORD` — suas credenciais de login
   - `AUTH_SESSION_SECRET` — `openssl rand -hex 32`
   - `DATABASE_PATH=/data/app.db` — precisa apontar para dentro do volume
4. Gere um domínio público para o serviço (Settings → Networking →
   Generate Domain).

Como o Next.js respeita a variável `PORT` do Railway automaticamente
(diferente do serviço Docker do Langfuse, que precisou de `PORT=3000`
fixo), não é necessário configurar isso aqui — o Railway injeta `PORT` e
o `next start` já escuta nela.

## Estrutura

```
app/
  layout.tsx                    # layout raiz
  page.tsx                      # UI do chat + sidebar de conversas
  login/page.tsx                # tela de login
  globals.css                   # estilos
  api/chat/route.ts             # busca no manual + Claude + Langfuse + persiste
  api/conversations/route.ts    # lista conversas
  api/conversations/[id]/route.ts  # mensagens de uma conversa
  api/feedback/route.ts         # 👍/👎 → score no Langfuse + SQLite
  api/login/route.ts            # valida credenciais, seta cookie
  api/logout/route.ts           # limpa cookie
  register-sw.tsx                # registra o service worker
knowledge/
  superendividamento-fluxo.md    # o manual — fonte de verdade do bot
lib/
  auth.ts                        # cria/verifica o token de sessão (JWT)
  db.ts                          # acesso ao SQLite (conversas/mensagens)
  knowledge.ts                   # índice FTS5 do manual + busca BM25
  langfuse.ts                    # cliente do Langfuse + flush com timeout
  prompt.ts                      # busca o prompt versionado (com fallback)
scripts/
  seed-prompt.mjs                # cria o prompt inicial no Langfuse
middleware.ts                    # protege rotas exigindo sessão válida
public/
  manifest.webmanifest           # manifest do PWA
  sw.js                          # service worker (cache de assets estáticos)
  icons/                         # ícones do app (192/256/384/512, maskable, apple)
```
