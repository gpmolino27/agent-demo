import fs from "node:fs";
import path from "node:path";

/**
 * Base de conhecimento: os .md em knowledge/ são a única fonte de verdade.
 *
 * O índice é BM25 em memória, em TypeScript puro, construído na primeira
 * busca. Os arquivos vêm junto com o repositório, então o índice é um derivado
 * puro deles — atualizar a base é editar o .md e fazer deploy, sem migração e
 * sem estado velho no volume. A base tem alguns KB; indexar leva milissegundos.
 *
 * A primeira versão disto usava FTS5 num segundo banco better-sqlite3 em
 * memória, e o processo passou a abortar em produção no destrutor nativo do
 * better-sqlite3 ("Assertion failed: (env) != nullptr" em
 * RemoveEnvironmentCleanupHook, vindo de Statement::~Statement) — derrubando o
 * servidor e, junto, os traces que ainda estavam sendo enviados. Não reproduzi
 * a corrida localmente, então em vez de apostar num mecanismo não confirmado,
 * o índice deixou de usar código nativo: são 16 trechos de um manual de 7KB,
 * onde um motor de full-text é desproporcional. Mesma fórmula, mesma
 * tokenização, zero handles nativos pro GC finalizar.
 */

const KNOWLEDGE_DIR = path.join(process.cwd(), "knowledge");

/** Quantos trechos vão pro modelo por pergunta. */
export const DEFAULT_TOP_K = 4;

/** Acima disso a seção é quebrada em pedaços menores, por parágrafo. */
const MAX_CHUNK_CHARS = 1800;

/**
 * Trecho que pontua abaixo desta fração do melhor resultado é descartado.
 * O BM25 sempre devolve algo pra qualquer palavra em comum; sem esse corte a
 * pergunta "qual o telefone do Procon?" arrasta junto três seções que só
 * mencionam "Procon" de passagem, e contexto irrelevante é o que faz o modelo
 * responder fora da fonte.
 */
const MIN_SCORE_RATIO = 0.15;

export type Chunk = {
  id: number;
  /** Título do documento (o `#` do arquivo). */
  doc: string;
  /** Título da seção (o `##`). */
  heading: string;
  /** Texto da seção, sem o heading. */
  body: string;
  /** Nome do arquivo de origem. */
  file: string;
};

export type Hit = Chunk & {
  /** Score do BM25: maior = mais relevante. */
  score: number;
};

/**
 * Stopwords do português. Servem só pra tirar ruído da query — o BM25 já dá
 * peso baixo pra termo que aparece em toda seção.
 */
const STOPWORDS = new Set([
  "a", "agora", "ainda", "ao", "aos", "aqui", "as", "ate", "com", "como",
  "da", "das", "de", "dela", "dele", "deles", "deve", "devo", "do", "dos",
  "e", "ela", "elas", "ele", "eles", "em", "entao", "entre", "essa", "esse",
  "esta", "estao", "este", "eu", "faco", "faz", "fazer", "foi", "isso",
  "isto", "ja", "la", "mais", "mas", "me", "meu", "minha", "muito", "na",
  "nao", "nas", "no", "nos", "num", "numa", "o", "os", "ou", "para", "pela",
  "pelo", "pod", "pode", "posso", "por", "porque", "pq", "pra", "precisa",
  "preciso", "pro", "qual", "quais", "quando", "quanta", "quantas", "quanto",
  "quantos", "que", "quem", "se", "sem", "sao", "ser", "seu", "sim", "so",
  "sobre", "sua", "tambem", "te", "tem", "tenho", "um", "uma", "voce", "vc",
]);


/** minúsculas + sem acento, pra "inscrição" casar com "inscricao". */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function tokenize(query: string): string[] {
  return [
    ...new Set(
      normalize(query)
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !STOPWORDS.has(t)),
    ),
  ];
}

/**
 * Quebra o markdown em seções `##`. Seção grande demais é dividida por
 * parágrafo, repetindo o heading — assim todo pedaço continua sabendo de onde
 * veio, que é o que vira a citação na resposta.
 */
function chunkMarkdown(markdown: string, file: string): Omit<Chunk, "id">[] {
  const lines = markdown.split("\n");

  let doc = file;
  let heading = "";
  let buffer: string[] = [];
  const sections: { heading: string; body: string }[] = [];

  const flush = () => {
    const body = buffer.join("\n").trim();
    if (heading && body) sections.push({ heading, body });
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith("# ")) {
      flush();
      doc = line.slice(2).trim();
      heading = "";
    } else if (line.startsWith("## ")) {
      flush();
      heading = line.slice(3).trim();
    } else {
      buffer.push(line);
    }
  }
  flush();

  const chunks: Omit<Chunk, "id">[] = [];
  for (const section of sections) {
    if (section.body.length <= MAX_CHUNK_CHARS) {
      chunks.push({ doc, file, ...section });
      continue;
    }

    let current: string[] = [];
    let size = 0;
    const push = () => {
      const body = current.join("\n\n").trim();
      if (body) chunks.push({ doc, file, heading: section.heading, body });
      current = [];
      size = 0;
    };

    for (const paragraph of section.body.split(/\n{2,}/)) {
      if (size > 0 && size + paragraph.length > MAX_CHUNK_CHARS) push();
      current.push(paragraph);
      size += paragraph.length;
    }
    push();
  }

  return chunks;
}

/** Um campo indexado: frequências por termo e o tamanho do documento. */
type Field = { freq: Map<string, number>; length: number };

type Doc = { chunk: Chunk; heading: Field; body: Field };

type Index = {
  docs: Doc[];
  /** Em quantos documentos cada termo aparece, por campo. */
  docFreq: { heading: Map<string, number>; body: Map<string, number> };
  avgLength: { heading: number; body: number };
};

/** Parâmetros clássicos do BM25. */
const K1 = 1.2;
const B = 0.75;

/** O heading nomeia o assunto da seção, então bater nele vale mais. */
const FIELD_WEIGHT = { heading: 3, body: 1 } as const;

let index: Index | null = null;

function toField(text: string): Field {
  const freq = new Map<string, number>();
  const tokens = normalize(text)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  for (const token of tokens) freq.set(token, (freq.get(token) ?? 0) + 1);
  return { freq, length: tokens.length };
}

function build(): Index {
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    // Sem a pasta knowledge/ o app roda sem base — o bot diz que não sabe.
    files = [];
  }

  const docs: Doc[] = [];
  for (const file of files) {
    const markdown = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8");
    for (const chunk of chunkMarkdown(markdown, file)) {
      docs.push({
        chunk: { id: docs.length + 1, ...chunk },
        heading: toField(chunk.heading),
        body: toField(chunk.body),
      });
    }
  }

  const docFreq = {
    heading: new Map<string, number>(),
    body: new Map<string, number>(),
  };
  const total = { heading: 0, body: 0 };

  for (const doc of docs) {
    for (const field of ["heading", "body"] as const) {
      total[field] += doc[field].length;
      for (const term of doc[field].freq.keys()) {
        docFreq[field].set(term, (docFreq[field].get(term) ?? 0) + 1);
      }
    }
  }

  console.log(
    `[knowledge] ${docs.length} trecho(s) indexado(s) de ${files.length} arquivo(s) em knowledge/.`,
  );

  return {
    docs,
    docFreq,
    avgLength: {
      heading: docs.length ? total.heading / docs.length : 0,
      body: docs.length ? total.body / docs.length : 0,
    },
  };
}

function getIndex(): Index {
  if (!index) index = build();
  return index;
}

/**
 * Busca os trechos mais relevantes pra pergunta, por BM25 somado sobre os dois
 * campos (heading e corpo), cada um com sua própria normalização de tamanho.
 */
export function searchKnowledge(query: string, topK = DEFAULT_TOP_K): Hit[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const { docs, docFreq, avgLength } = getIndex();
  if (docs.length === 0) return [];

  const scored: Hit[] = [];

  for (const doc of docs) {
    let score = 0;

    for (const field of ["heading", "body"] as const) {
      const avg = avgLength[field];
      if (avg === 0) continue;

      for (const term of terms) {
        const tf = doc[field].freq.get(term);
        if (!tf) continue;

        const n = docFreq[field].get(term) ?? 0;
        const idf = Math.log(1 + (docs.length - n + 0.5) / (n + 0.5));
        const norm = 1 - B + (B * doc[field].length) / avg;

        score += FIELD_WEIGHT[field] * idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
      }
    }

    if (score > 0) scored.push({ ...doc.chunk, score });
  }

  scored.sort((a, b) => b.score - a.score);

  const hits = scored.slice(0, topK);
  const best = hits[0]?.score ?? 0;
  return hits.filter((hit) => hit.score >= best * MIN_SCORE_RATIO);
}
