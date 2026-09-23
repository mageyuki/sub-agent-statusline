import { describe, it, expect, vi } from "vitest";
import { t, detectSystemLocale, type Locale } from "./i18n.js";

describe("i18n", () => {
  describe("detectSystemLocale", () => {
    it("returns 'es' when LANG environment starts with 'es'", () => {
      const original = process.env.LANG;
      process.env.LANG = "es_ES.UTF-8";
      const result = detectSystemLocale();
      if (original !== undefined) process.env.LANG = original;
      else delete process.env.LANG;
      expect(result).toBe("es");
    });

    it("returns 'en' when LANG environment starts with 'en'", () => {
      const original = process.env.LANG;
      process.env.LANG = "en_US.UTF-8";
      const result = detectSystemLocale();
      if (original !== undefined) process.env.LANG = original;
      else delete process.env.LANG;
      expect(result).toBe("en");
    });

    it("returns 'en' as fallback for unsupported locales", () => {
      const original = process.env.LANG;
      process.env.LANG = "ja_JP.UTF-8";
      const result = detectSystemLocale();
      if (original !== undefined) process.env.LANG = original;
      else delete process.env.LANG;
      expect(result).toBe("en");
    });

    it("returns 'en' when no LANG env var is set", () => {
      const original = process.env.LANG;
      delete process.env.LANG;
      const result = detectSystemLocale();
      if (original !== undefined) process.env.LANG = original;
      expect(result).toBe("en");
    });
  });

  describe("t()", () => {
    it.each([
      ["en_US.UTF-8", ["Interrupted", "Status may be stale", "Input + output usage", "Subagent list unavailable"]],
      ["es_ES.UTF-8", ["Interrumpido", "El estado puede estar desactualizado", "Uso de entrada + salida", "Lista de subagentes no disponible"]],
    ])("provides concise V2 feedback in %s", async (locale, expected) => {
      const original = process.env.LANG;
      try {
        process.env.LANG = locale;
        vi.resetModules();
        const dictionary = await import("./i18n.js");
        expect([dictionary.t("interrupted"), dictionary.t("stale"),
          dictionary.t("usage"), dictionary.t("unavailable")]).toEqual(expected);
      } finally {
        if (original === undefined) delete process.env.LANG;
        else process.env.LANG = original;
      }
    });
    it("returns translated string for 'subagents' key", () => {
      const result = t("subagents");
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });
  });
});
