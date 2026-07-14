import "@testing-library/jest-dom";
import { vi } from "vitest";

// canvas benötigt libuuid (nicht im Replit-Container) → mocken bevor jsdom es lädt
vi.mock("canvas", () => ({
  createCanvas: () => ({}),
  loadImage: async () => ({}),
}));

// window ist nur in jsdom-Umgebung verfügbar, nicht in node-Umgebung
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
}
