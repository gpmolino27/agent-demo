import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Agent Demo",
  description: "Agente simples com Claude, instrumentado com Langfuse",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
