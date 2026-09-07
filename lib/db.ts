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
};

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
  return db
    .prepare(
      `SELECT id, conversation_id as conversationId, role, content, created_at as createdAt
       FROM messages
       WHERE conversation_id = ?
       ORDER BY id ASC`,
    )
    .all(conversationId) as StoredMessage[];
}

export function addMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO messages (conversation_id, role, content, created_at)
     VALUES (?, ?, ?, ?)`,
  ).run(conversationId, role, content, now);
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(
    now,
    conversationId,
  );
}
