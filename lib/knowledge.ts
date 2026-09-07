import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

/**
 * Base de conhecimento: os .md em knowledge/ são a única fonte de verdade.
 *
 * O índice é FTS5 num banco em memória, reconstruído no boot. Os arquivos vêm
 * junto com o repositório, então o índice é um derivado puro deles — atualizar
 * a base é editar o .md e fazer deploy, sem migração e sem estado velho no
 * volume. A base tem alguns KB; indexar leva milissegundos.
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
  /** rowid no índice FTS5. */
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
  /** Score do BM25 já invertido: maior = mais relevante. */
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


/** minúsculas + sem acento, pra casar com o tokenizer do FTS5. */
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

type Index = { db: Database.Database; chunks: Chunk[] };

let index: Index | null = null;

function build(): Index {
  const db = new Database(":memory:");
  db.exec(`
    CREATE VIRTUAL TABLE chunks USING fts5(
      heading,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);

  let files: string[] = [];
  try {
    files = fs
      .readdirSync(KNOWLEDGE_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort();
  } catch {
    // Sem a pasta knowledge/ o app roda sem base — o bot diz que não sabe.
    return { db, chunks: [] };
  }

  const chunks: Chunk[] = [];
  const insert = db.prepare(
    "INSERT INTO chunks (rowid, heading, body) VALUES (?, ?, ?)",
  );

  for (const file of files) {
    const markdown = fs.readFileSync(path.join(KNOWLEDGE_DIR, file), "utf8");
    for (const chunk of chunkMarkdown(markdown, file)) {
      const id = chunks.length + 1;
      chunks.push({ id, ...chunk });
      insert.run(id, chunk.heading, chunk.body);
    }
  }

  console.log(
    `[knowledge] ${chunks.length} trecho(s) indexado(s) de ${files.length} arquivo(s) em knowledge/.`,
  );

  return { db, chunks };
}

function getIndex(): Index {
  if (!index) index = build();
  return index;
}

/**
 * Busca os trechos mais relevantes pra pergunta.
 * O heading pesa 3x o corpo: as seções aqui são nomeadas pelo assunto
 * ("Linhas vermelhas", "Etapa 2 — Dossiê"), então bater no título é forte.
 */
export function searchKnowledge(query: string, topK = DEFAULT_TOP_K): Hit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const { db, chunks } = getIndex();
  if (chunks.length === 0) return [];

  const match = tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" OR ");

  let rows: { rowid: number; score: number }[];
  try {
    rows = db
      .prepare(
        `SELECT rowid, bm25(chunks, 3.0, 1.0) AS score
         FROM chunks
         WHERE chunks MATCH ?
         ORDER BY score
         LIMIT ?`,
      )
      .all(match, topK) as { rowid: number; score: number }[];
  } catch {
    // Query malformada pro FTS5 não pode derrubar o chat.
    return [];
  }

  // bm25 é negativo (mais negativo = melhor); inverte pra ficar legível.
  const hits = rows.map((row) => ({
    ...chunks[row.rowid - 1],
    score: -row.score,
  }));

  const best = hits[0]?.score ?? 0;
  return hits.filter((hit) => hit.score >= best * MIN_SCORE_RATIO);
}
