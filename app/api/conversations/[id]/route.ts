import { NextRequest, NextResponse } from "next/server";
import { conversationExists, getMessages } from "@/lib/db";

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
    role: m.role,
    content: m.content,
  }));

  return NextResponse.json({ messages });
}
