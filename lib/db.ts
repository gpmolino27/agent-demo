import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DB_PATH =
  process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Migração idempotente: bancos criados antes destas colunas continuam válidos.
function ensureColumn(table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!columns.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

// trace_id liga a mensagem ao trace no Langfuse (pra anexar o feedback nele).
ensureColumn("messages", "trace_id", "TEXT");
// feedback: 1 = 👍, 0 = 👎, NULL = sem avaliação.
ensureColumn("messages", "feedback", "INTEGER");
// sources: JSON com as seções do manual que a resposta citou.
ensureColumn("messages", "sources", "TEXT");

export type Conversation = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type StoredMessage = {
  id: number;
  conversationId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  traceId: string | null;
  feedback: number | null;
  /** Seções do manual citadas na resposta (JSON no banco, array aqui). */
  sources: string[];
};

type MessageRow = Omit<StoredMessage, "sources"> & { sources: string | null };

function toMessage(row: MessageRow): StoredMessage {
  let sources: string[] = [];
  if (row.sources) {
    try {
      const parsed: unknown = JSON.parse(row.sources);
      if (Array.isArray(parsed)) sources = parsed.filter((s) => typeof s === "string");
    } catch {
      // Linha antiga ou corrompida: melhor sem fontes do que quebrar a conversa.
    }
  }
  return { ...row, sources };
}

export function listConversations(): Conversation[] {
  return db
    .prepare(
      `SELECT id, title, created_at as createdAt, updated_at as updatedAt
       FROM conversations
       ORDER BY updated_at DESC`,
    )
    .all() as Conversation[];
}

export function conversationExists(id: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(id),
  );
}

export function createConversation(title: string): Conversation {
  const id = randomUUID();
  const now = Date.now();
  db.prepare(
    `INSERT INTO conversations (id, title, created_at, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(id, title, now, now);
  return { id, title, createdAt: now, updatedAt: now };
}

export function getMessages(conversationId: string): StoredMessage[] {
  const rows = db
    .prepare(
      `SELECT id, conversation_id as conversationId, role, content,
              created_at as createdAt, trace_id as traceId, feedback, sources
       FROM messages
       WHERE conversation_id = ?
       ORDER BY id ASC`,
    )
    .all(conversationId) as MessageRow[];
  return rows.map(toMessage);
}

/** Retorna o id da mensagem inserida (usado pra anexar feedback depois). */
export function addMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  traceId?: string | null,
  sources?: string[],
): number {
  const now = Date.now();
  const result = db
    .prepare(
      `INSERT INTO messages (conversation_id, role, content, created_at, trace_id, sources)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      conversationId,
      role,
      content,
      now,
      traceId ?? null,
      sources && sources.length > 0 ? JSON.stringify(sources) : null,
    );
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
    now,
    conversationId,
  );
  return Number(result.lastInsertRowid);
}

export function getMessage(id: number): StoredMessage | undefined {
  const row = db
    .prepare(
      `SELECT id, conversation_id as conversationId, role, content,
              created_at as createdAt, trace_id as traceId, feedback, sources
       FROM messages
       WHERE id = ?`,
    )
    .get(id) as MessageRow | undefined;
  return row ? toMessage(row) : undefined;
}

/** value: 1 = 👍, 0 = 👎, null = remove a avaliação. */
export function setMessageFeedback(id: number, value: number | null) {
  db.prepare("UPDATE messages SET feedback = ? WHERE id = ?").run(value, id);
}

const deleteConversationTx = db.transaction((id: string) => {
  db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(id);
  db.prepare("DELETE FROM conversations WHERE id = ?").run(id);
});

export function deleteConversation(id: string) {
  deleteConversationTx(id);
}
