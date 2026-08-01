import { describe, expect, it } from "vitest";
import { normalise } from "../../src/capture/normalise.js";

/**
 * Normalisation is exactly three rules, and this file asserts their limits as
 * much as their effects. It is the test that fails when someone adds a fourth,
 * which is the point of it: `add.md` §5.1 warns that an open-ended normaliser
 * becomes a second, undisciplined extractor, and the only defence is a closed
 * list with a test that notices additions.
 */
describe("normalise", () => {
  describe("the three rules", () => {
    it("composes characters to NFC", () => {
      const decomposed = "José";
      expect(normalise(decomposed)).toBe("José");
      expect(normalise(decomposed).normalize("NFD")).not.toBe(normalise(decomposed));
    });

    it("collapses every run of whitespace to a single space", () => {
      expect(normalise("Coffee   with    Sarah")).toBe("Coffee with Sarah");
    });

    it("collapses newlines too, because a Capture is one thought and not a document", () => {
      expect(normalise("Call Sarah\nabout Helios")).toBe("Call Sarah about Helios");
      expect(normalise("a\r\n\r\nb")).toBe("a b");
    });

    it("treats Unicode whitespace as whitespace, not just ASCII", () => {
      const nonBreakingSpace = "Ship Helios";
      const enQuad = "Ship Helios";
      expect(normalise(nonBreakingSpace)).toBe("Ship Helios");
      expect(normalise(enQuad)).toBe("Ship Helios");
    });

    it("trims leading and trailing whitespace", () => {
      expect(normalise("  Ship Helios  ")).toBe("Ship Helios");
      expect(normalise("\n\tShip Helios\n")).toBe("Ship Helios");
    });

    it("applies NFC before collapsing, so the whitespace steps see composed characters", () => {
      expect(normalise("  José   Rodríguez  ")).toBe("José Rodríguez");
    });
  });

  /**
   * The limits. Each of these is a rule somebody will eventually be tempted to
   * add, and each requires deciding what the user meant — which is extraction's
   * job, one stage later.
   */
  describe("what it deliberately does not do", () => {
    it("leaves punctuation exactly as it arrived", () => {
      expect(normalise("call sarah!!! about helios???")).toBe("call sarah!!! about helios???");
      expect(normalise("Helios -- the rollout")).toBe("Helios -- the rollout");
    });

    it("leaves capitalisation alone", () => {
      expect(normalise("coffee with sarah")).toBe("coffee with sarah");
      expect(normalise("COFFEE WITH SARAH")).toBe("COFFEE WITH SARAH");
    });

    it("leaves filler words in", () => {
      expect(normalise("um so like the Helios thing uh")).toBe("um so like the Helios thing uh");
    });

    it("notices nothing semantic, dates included", () => {
      const text = "Ship Helios next Tuesday";
      expect(normalise(text)).toBe(text);
    });
  });

  describe("edge cases", () => {
    it("returns empty for text that is entirely whitespace", () => {
      expect(normalise("   \n\t  ")).toBe("");
    });

    it("is idempotent — normalising twice equals normalising once", () => {
      const once = normalise("  Coffee\n\nwith   Sarah  ");
      expect(normalise(once)).toBe(once);
    });
  });
});
