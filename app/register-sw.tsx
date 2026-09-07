"use client";

import { useEffect } from "react";

export function RegisterServiceWorker() {
  useEffect(() => {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        // Registro do service worker é best-effort: falhar aqui não deve
        // quebrar o app (ex: navegador sem suporte, contexto não seguro).
      });
    }
  }, []);

  return null;
}
