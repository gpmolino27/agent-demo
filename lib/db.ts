import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DB_PATH =
  process.env.DATABASE_PATH || path.join(process.cwd(), "data", "app.db");

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

const MESSAGE_COLUMNS = `id, conversation_id as conversationId, role, content,
       created_at as createdAt, trace_id as traceId, feedback, sources`;

type Handle = {
  db: Database.Database;
  /**
   * Statements preparados uma vez e guardados pela vida do processo.
   *
   * Não é (só) otimização. Preparar dentro de cada função deixa um Statement
   * nativo órfão por chamada, e o processo em produção abortava quando o GC
   * finalizava um deles:
   *
   *   Assertion failed: (env) != nullptr
   *   node::RemoveEnvironmentCleanupHook(...)
   *   Statement::~Statement()  [better-sqlite3]
   *
   * Statement que nunca vira lixo nunca tem o destrutor chamado.
   */
  stmt: {
    listConversations: Database.Statement;
    conversationExists: Database.Statement;
    insertConversation: Database.Statement;
    touchConversation: Database.Statement;
    deleteConversation: Database.Statement;
    messagesByConversation: Database.Statement;
    messageById: Database.Statement;
    insertMessage: Database.Statement;
    setFeedback: Database.Statement;
    deleteMessagesOf: Database.Statement;
  };
  deleteConversationTx: Database.Transaction<(id: string) => void>;
};

let handle: Handle | null = null;

/** Abre o banco na primeira consulta, não no import do módulo. */
function open(): Handle {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  // Se outro processo estiver escrevendo, espera em vez de falhar na hora.
  db.pragma("busy_timeout = 5000");

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

  // Migração idempotente. Usa db.pragma() em vez de db.prepare() de propósito:
  // não deixa Statement órfão pro GC (ver o comentário em Handle.stmt).
  const ensureColumn = (table: string, column: string, definition: string) => {
    const columns = db.pragma(`table_info(${table})`) as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  // trace_id liga a mensagem ao trace no Langfuse (pra anexar o feedback nele).
  ensureColumn("messages", "trace_id", "TEXT");
  // feedback: 1 = 👍, 0 = 👎, NULL = sem avaliação.
  ensureColumn("messages", "feedback", "INTEGER");
  // sources: JSON com as seções do manual que a resposta citou.
  ensureColumn("messages", "sources", "TEXT");

  const stmt: Handle["stmt"] = {
    listConversations: db.prepare(
      `SELECT id, title, created_at as createdAt, updated_at as updatedAt
       FROM conversations
       ORDER BY updated_at DESC`,
    ),
    conversationExists: db.prepare("SELECT 1 FROM conversations WHERE id = ?"),
    insertConversation: db.prepare(
      `INSERT INTO conversations (id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    ),
    touchConversation: db.prepare(
      "UPDATE conversations SET updated_at = ? WHERE id = ?",
    ),
    deleteConversation: db.prepare("DELETE FROM conversations WHERE id = ?"),
    messagesByConversation: db.prepare(
      `SELECT ${MESSAGE_COLUMNS}
       FROM messages
       WHERE conversation_id = ?
       ORDER BY id ASC`,
    ),
    messageById: db.prepare(
      `SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`,
    ),
    insertMessage: db.prepare(
      `INSERT INTO messages (conversation_id, role, content, created_at, trace_id, sources)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ),
    setFeedback: db.prepare("UPDATE messages SET feedback = ? WHERE id = ?"),
    deleteMessagesOf: db.prepare(
      "DELETE FROM messages WHERE conversation_id = ?",
    ),
  };

  const deleteConversationTx = db.transaction((id: string) => {
    stmt.deleteMessagesOf.run(id);
    stmt.deleteConversation.run(id);
  });

  return { db, stmt, deleteConversationTx };
}

function get(): Handle {
  if (!handle) handle = open();
  return handle;
}

function toMessage(row: MessageRow): StoredMessage {
  let sources: string[] = [];
  if (row.sources) {
    try {
      const parsed: unknown = JSON.parse(row.sources);
      if (Array.isArray(parsed)) {
        sources = parsed.filter((s) => typeof s === "string");
      }
    } catch {
      // Linha antiga ou corrompida: melhor sem fontes do que quebrar a conversa.
    }
  }
  return { ...row, sources };
}

export function listConversations(): Conversation[] {
  return get().stmt.listConversations.all() as Conversation[];
}

export function conversationExists(id: string): boolean {
  return Boolean(get().stmt.conversationExists.get(id));
}

export function createConversation(title: string): Conversation {
  const id = randomUUID();
  const now = Date.now();
  get().stmt.insertConversation.run(id, title, now, now);
  return { id, title, createdAt: now, updatedAt: now };
}

export function getMessages(conversationId: string): StoredMessage[] {
  const rows = get().stmt.messagesByConversation.all(
    conversationId,
  ) as MessageRow[];
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
  const { stmt } = get();
  const now = Date.now();
  const result = stmt.insertMessage.run(
    conversationId,
    role,
    content,
    now,
    traceId ?? null,
    sources && sources.length > 0 ? JSON.stringify(sources) : null,
  );
  stmt.touchConversation.run(now, conversationId);
  return Number(result.lastInsertRowid);
}

export function getMessage(id: number): StoredMessage | undefined {
  const row = get().stmt.messageById.get(id) as MessageRow | undefined;
  return row ? toMessage(row) : undefined;
}

/** value: 1 = 👍, 0 = 👎, null = remove a avaliação. */
export function setMessageFeedback(id: number, value: number | null) {
  get().stmt.setFeedback.run(value, id);
}

export function deleteConversation(id: string) {
  get().deleteConversationTx(id);
}
