import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { MODEL_SYNONYMS, MODEL_PATTERNS } = require("../../src/mitm/config.js");

describe("Antigravity MITM model mappings", () => {
  it("maps Antigravity-sent raw model IDs to themselves (canonical)", () => {
    // Verified via MITM debug capture 2026-05-20: Antigravity sends
    // gemini-3-flash-agent for the "High" quota tier and gemini-3.5-flash-low
    // for the "Medium" tier.
    expect(MODEL_SYNONYMS.antigravity["gemini-default"]).toBe("gemini-3-flash-agent");
    expect(MODEL_SYNONYMS.antigravity["gemini-3-flash-agent"]).toBe("gemini-3-flash-agent");
    expect(MODEL_SYNONYMS.antigravity["gemini-3.5-flash-low"]).toBe("gemini-3.5-flash-low");
  });

  it("keeps legacy synonyms pointing at the closest current model", () => {
    expect(MODEL_SYNONYMS.antigravity["gemini-3.5-flash"]).toBe("gemini-3.5-flash-low");
    expect(MODEL_SYNONYMS.antigravity["gemini-3-flash"]).toBe("gemini-3-flash-agent");
  });

  it("does not yet expose Opus 4.7 (commented-out scaffold)", () => {
    expect(MODEL_SYNONYMS.antigravity["claude-opus-4-7"]).toBeUndefined();
    expect(MODEL_SYNONYMS.antigravity["claude-opus-4-7-thinking"]).toBeUndefined();
    expect(MODEL_SYNONYMS.antigravity["claude-opus-4-6"]).toBe("claude-opus-4-6-thinking");
  });

  it("pattern fallback routes renamed flash variants correctly", () => {
    const patternAliasFor = (rawModel) => MODEL_PATTERNS.antigravity.find(({ match }) => match.test(rawModel))?.alias;

    expect(patternAliasFor("gemini-3.5-flash-low")).toBe("gemini-3.5-flash-low");
    expect(patternAliasFor("gemini-3-flash-agent")).toBe("gemini-3-flash-agent");
    expect(patternAliasFor("Gemini Flash Agent")).toBe("gemini-3-flash-agent");
    expect(patternAliasFor("gemini-3.5-flash")).toBe("gemini-3.5-flash-low");
    expect(patternAliasFor("Some Flash Model")).toBe("gemini-3-flash-agent"); // generic flash → high tier
    expect(patternAliasFor("Claude Opus")).toBe("claude-opus-4-6-thinking");
  });
});
