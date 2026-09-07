"use client";

import { useEffect } from "react";

// Alguns navegadores mobile (principalmente Android/Chrome com barra de
// navegação de 3 botões) não excluem essa barra corretamente de 100vh/100dvh.
// Medimos a altura real disponível via JS e expomos como --app-height,
// reagindo a resize, rotação e ao teclado virtual abrindo/fechando.
export function ViewportHeight() {
  useEffect(() => {
    function setHeight() {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${height}px`);
    }

    setHeight();

    window.addEventListener("resize", setHeight);
    window.addEventListener("orientationchange", setHeight);
    window.visualViewport?.addEventListener("resize", setHeight);

    return () => {
      window.removeEventListener("resize", setHeight);
      window.removeEventListener("orientationchange", setHeight);
      window.visualViewport?.removeEventListener("resize", setHeight);
    };
  }, []);

  return null;
}
