import { createHmac, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createSessionToken, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

// Compara em tempo constante, sem exigir que as strings tenham o mesmo
// tamanho (evita vazar informação por timing e por erro de tamanho).
function safeEqual(a: string, b: string): boolean {
  const key = "agent-demo-compare";
  const ha = createHmac("sha256", key).update(a).digest();
  const hb = createHmac("sha256", key).update(b).digest();
  return timingSafeEqual(ha, hb);
}

export async function POST(req: NextRequest) {
  const expectedEmail = process.env.AUTH_EMAIL;
  const expectedPassword = process.env.AUTH_PASSWORD;

  if (!expectedEmail || !expectedPassword) {
    return NextResponse.json(
      {
        error:
          "Login não configurado no servidor (AUTH_EMAIL/AUTH_PASSWORD ausentes).",
      },
      { status: 500 },
    );
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email : "";
  const password = typeof body?.password === "string" ? body.password : "";

  if (!safeEqual(email, expectedEmail) || !safeEqual(password, expectedPassword)) {
    return NextResponse.json(
      { error: "E-mail ou senha inválidos." },
      { status: 401 },
    );
  }

  const token = await createSessionToken(email);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return res;
}
