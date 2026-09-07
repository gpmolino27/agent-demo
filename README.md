# Agent Demo

App web simples em Next.js + TypeScript: um chat que chama o Claude
(Anthropic) e envia cada troca de mensagens como um trace para o
[Langfuse](https://github.com/gpmolino27/langfuse-selfhost) self-hosted.

## Como funciona

- `app/page.tsx` — UI de chat (client component), sem dependências externas
  de estilo.
- `app/api/chat/route.ts` — rota de API (Node runtime) que:
  1. cria um `trace` e uma `generation` no Langfuse antes de chamar o modelo;
  2. chama `anthropic.messages.create(...)`;
  3. fecha a `generation` com o output e uso de tokens;
  4. dá `flush` no cliente do Langfuse antes de responder (importante em
     ambientes serverless/short-lived, senão o evento pode não ser enviado).

Se as variáveis `LANGFUSE_PUBLIC_KEY`/`LANGFUSE_SECRET_KEY` não estiverem
configuradas, o app funciona normalmente só sem enviar traces (fica só
o chat com o Claude).

## Rodando localmente

```bash
npm install
cp .env.example .env.local
# edite .env.local com sua ANTHROPIC_API_KEY e as chaves do projeto no Langfuse
npm run dev
```

Abra http://localhost:3000.

### Obtendo as chaves do Langfuse

1. Acesse seu Langfuse self-hosted e faça login.
2. Abra o projeto (ex: "Default Project") → **Settings → API Keys**.
3. Crie um novo par de chaves e copie `Public Key` e `Secret Key` para o
   `.env.local` (`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`).
4. `LANGFUSE_BASEURL` é a URL do seu Langfuse (ex:
   `https://langfuse-web-production-e419.up.railway.app`).

## Deploy no Railway

1. Crie um novo projeto no Railway e conecte este repositório
   (`gpmolino27/agent-demo`) via GitHub — o Railway detecta Next.js
   automaticamente (Railpack) e roda `npm install && npm run build` /
   `npm start`.
2. Configure as variáveis de ambiente do serviço:
   - `ANTHROPIC_API_KEY`
   - `LANGFUSE_PUBLIC_KEY`
   - `LANGFUSE_SECRET_KEY`
   - `LANGFUSE_BASEURL`
3. Gere um domínio público para o serviço (Settings → Networking →
   Generate Domain).

Como o Next.js respeita a variável `PORT` do Railway automaticamente
(diferente do serviço Docker do Langfuse, que precisou de `PORT=3000`
fixo), não é necessário configurar isso aqui — o Railway injeta `PORT` e
o `next start` já escuta nela.

## Estrutura

```
app/
  layout.tsx        # layout raiz
  page.tsx           # UI do chat
  globals.css         # estilos
  api/chat/route.ts   # endpoint que chama Claude + Langfuse
```
