import { NextRequest, NextResponse } from "next/server";
import { conversationExists, deleteConversation, getMessages } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!conversationExists(id)) {
    return NextResponse.json(
      { error: "Conversa não encontrada." },
      { status: 404 },
    );
  }

  const messages = getMessages(id).map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    feedback: m.feedback,
    sources: m.sources,
  }));

  return NextResponse.json({ messages });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  if (!conversationExists(id)) {
    return NextResponse.json(
      { error: "Conversa não encontrada." },
      { status: 404 },
    );
  }

  deleteConversation(id);

  return NextResponse.json({ ok: true });
}
