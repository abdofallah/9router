import { describe, it, expect } from "vitest";

import {
  EffortValidationError,
  allowedEffortLevels,
  getClaudeModelClass,
  getEffortCapability,
  isAdaptiveThinkingModel,
  isClaudeProviderModel,
  parseEffortKeywords,
  supportsEffort,
  supportsManualThinking,
  supportsMaxEffort,
  supportsXHighEffort,
} from "../../open-sse/utils/claudeEffort.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

describe("claudeEffort util", () => {
  describe("model class detection", () => {
    it.each([
      ["claude-mythos-preview", "mythos"],
      ["claude-opus-4-7", "opus-4-7"],
      ["claude-opus-4-7-20251001", "opus-4-7"],
      ["cc/claude-opus-4-6", "opus-4-6"],
      ["claude-sonnet-4-6", "sonnet-4-6"],
      ["claude-opus-4-5", "opus-4-5"],
      ["claude-sonnet-4-5", "sonnet-4-5"],
      ["claude-haiku-4-5", "haiku-4-5"],
      ["claude-opus-4-1", "opus-4-1"],
      ["claude-opus-4", "opus-4"],
      ["claude-sonnet-4", "sonnet-4"],
      ["claude-sonnet-3-7", "sonnet-3-7"],
      ["claude-sonnet-3.7", "sonnet-3-7"],
    ])("classifies %s as %s", (model, klass) => {
      expect(getClaudeModelClass(model)).toBe(klass);
    });

    it("returns null for unknown / non-Claude-provider models", () => {
      expect(getClaudeModelClass("")).toBeNull();
      expect(getClaudeModelClass(null)).toBeNull();
      expect(getClaudeModelClass("gpt-4o")).toBeNull();
      expect(getClaudeModelClass("gemini-3-flash")).toBeNull();
      expect(getClaudeModelClass("openrouter/anthropic/claude-opus-4-7")).toBeNull();
      expect(getClaudeModelClass("vercel/claude-sonnet-4-6")).toBeNull();
      expect(getClaudeModelClass("custom/claude-opus-4-5")).toBeNull();
    });

    it("recognizes only first-party Claude provider routes and bare Claude IDs", () => {
      expect(isClaudeProviderModel("cc/claude-opus-4-7")).toBe(true);
      expect(isClaudeProviderModel("claude/claude-sonnet-4-6")).toBe(true);
      expect(isClaudeProviderModel("claude-opus-4-7")).toBe(true);
      expect(isClaudeProviderModel("openrouter/anthropic/claude-opus-4-7")).toBe(false);
      expect(isClaudeProviderModel("anthropic/claude-opus-4-7")).toBe(false);
      expect(isClaudeProviderModel("custom/claude-sonnet-4-6")).toBe(false);
    });

    it("disambiguates plain opus-4 from opus-4-N variants", () => {
      // Regression: ensure opus-4-6 doesn't accidentally classify as opus-4.
      expect(getClaudeModelClass("claude-opus-4-6")).toBe("opus-4-6");
      expect(getClaudeModelClass("claude-opus-4")).toBe("opus-4");
    });
  });

  describe("per-model capabilities", () => {
    const matrix = [
      // [model,                effort, levels,                         adaptive, manualBudget]
      ["claude-mythos-preview", true,  ["low","medium","high","max"],          true,  false],
      ["claude-opus-4-7",       true,  ["low","medium","high","xhigh","max"],  true,  false],
      ["claude-opus-4-6",       true,  ["low","medium","high","max"],          true,  true ],
      ["claude-sonnet-4-6",     true,  ["low","medium","high","max"],          true,  true ],
      ["claude-opus-4-5",       true,  ["low","medium","high"],                false, true ],
      ["claude-sonnet-4-5",     false, [],                                     false, true ],
      ["claude-haiku-4-5",      false, [],                                     false, true ],
      ["claude-opus-4-1",       false, [],                                     false, true ],
      ["claude-opus-4",         false, [],                                     false, true ],
      ["claude-sonnet-4",       false, [],                                     false, true ],
      ["claude-sonnet-3-7",     false, [],                                     false, true ],
      ["gpt-4o",                false, [],                                     false, false], // non-Claude
    ];

    it.each(matrix)("getEffortCapability(%s) returns the published matrix", (model, effort, levels, adaptive, manualBudget) => {
      const cap = getEffortCapability(model);
      expect(cap.effort).toBe(effort);
      expect(cap.levels).toEqual(levels);
      expect(cap.adaptive).toBe(adaptive);
      expect(cap.manualBudget).toBe(manualBudget);
      expect(cap.supported).toBe(effort || manualBudget);
    });

    it.each([
      "openrouter/anthropic/claude-opus-4-7",
      "vercel/claude-sonnet-4-6",
      "custom/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
    ])("does not expose Claude effort/thinking controls for non-Claude provider route %s", (model) => {
      const cap = getEffortCapability(model);
      expect(cap).toMatchObject({
        class: null,
        effort: false,
        adaptive: false,
        manualBudget: false,
        supported: false,
        levels: [],
      });
      expect(supportsEffort(model)).toBe(false);
      expect(supportsManualThinking(model)).toBe(false);
      expect(allowedEffortLevels(model).size).toBe(0);
    });

    it("adaptive thinking includes Mythos / Opus 4.7 / Opus 4.6 / Sonnet 4.6 — NOT Haiku or Opus 4.5", () => {
      expect(isAdaptiveThinkingModel("claude-mythos-preview")).toBe(true);
      expect(isAdaptiveThinkingModel("claude-opus-4-7")).toBe(true);
      expect(isAdaptiveThinkingModel("claude-opus-4-6")).toBe(true);
      expect(isAdaptiveThinkingModel("claude-sonnet-4-6")).toBe(true);
      // Notable exclusions per the spec
      expect(isAdaptiveThinkingModel("claude-opus-4-5")).toBe(false);
      expect(isAdaptiveThinkingModel("claude-haiku-4-5")).toBe(false);
      expect(isAdaptiveThinkingModel("claude-sonnet-4-5")).toBe(false);
    });

    it("manual thinking excludes Mythos (no manual mode) and Opus 4.7 (rejected 400)", () => {
      expect(supportsManualThinking("claude-mythos-preview")).toBe(false);
      expect(supportsManualThinking("claude-opus-4-7")).toBe(false);
      // Everything else accepts manual budget.
      expect(supportsManualThinking("claude-opus-4-6")).toBe(true);
      expect(supportsManualThinking("claude-sonnet-4-6")).toBe(true);
      expect(supportsManualThinking("claude-opus-4-5")).toBe(true);
      expect(supportsManualThinking("claude-haiku-4-5")).toBe(true);
    });

    it("max effort is available on Mythos / Opus 4.7 / Opus 4.6 / Sonnet 4.6 (not Opus 4.5)", () => {
      expect(supportsMaxEffort("claude-mythos-preview")).toBe(true);
      expect(supportsMaxEffort("claude-opus-4-7")).toBe(true);
      expect(supportsMaxEffort("claude-opus-4-6")).toBe(true);
      expect(supportsMaxEffort("claude-sonnet-4-6")).toBe(true);
      expect(supportsMaxEffort("claude-opus-4-5")).toBe(false);
      expect(supportsMaxEffort("claude-haiku-4-5")).toBe(false);
    });

    it("xhigh effort is Opus 4.7-exclusive", () => {
      expect(supportsXHighEffort("claude-opus-4-7")).toBe(true);
      expect(supportsXHighEffort("claude-opus-4-6")).toBe(false);
      expect(supportsXHighEffort("claude-mythos-preview")).toBe(false);
      expect(supportsXHighEffort("claude-sonnet-4-6")).toBe(false);
    });

    it("supportsEffort is the union of all effort-supporting models", () => {
      expect(supportsEffort("claude-opus-4-5")).toBe(true); // 4.5 supports effort
      expect(supportsEffort("claude-sonnet-4-5")).toBe(false);
      expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    });
  });

  describe("parseEffortKeywords", () => {
    it("returns defaults when no keyword present", () => {
      const out = parseEffortKeywords([{ role: "user", content: "hello" }], { effort: "medium" });
      expect(out.effort).toBe("medium");
      expect(out.matched).toBe(false);
      expect(out.fromKeyword.effort).toBe(false);
    });

    it.each(["low", "medium", "high", "xhigh", "max"])(
      "captures [effortlevel:%s] and reports fromKeyword.effort=true",
      (lvl) => {
        const out = parseEffortKeywords([{ role: "user", content: `do it [effortlevel:${lvl}]` }]);
        expect(out.effort).toBe(lvl);
        expect(out.fromKeyword.effort).toBe(true);
      }
    );

    it("[thinkingbudget:N] captured + fromKeyword.budget=true", () => {
      const out = parseEffortKeywords([{ role: "user", content: "[thinkingbudget:8192] start" }]);
      expect(out.budgetTokens).toBe(8192);
      expect(out.fromKeyword.budget).toBe(true);
    });

    it("strips unknown values from the prompt (permissive strip)", () => {
      const out = parseEffortKeywords([{ role: "user", content: "hey [effortlevel:gibberish]" }]);
      expect(out.effort).toBeUndefined();
      expect(out.messages[0].content).toBe("hey");
    });

    it("cleans Antigravity USER_REQUEST wrapper with no trailing whitespace", () => {
      const wrapped = "<USER_REQUEST>\nhey [effortlevel:xhigh]\n</USER_REQUEST>\n<META>x</META>";
      const out = parseEffortKeywords([{ role: "user", content: wrapped }]);
      expect(out.effort).toBe("xhigh");
      expect(out.messages[0].content).toBe("<USER_REQUEST>\nhey\n</USER_REQUEST>\n<META>x</META>");
    });

    it("strips keywords from every user message (not just the one with the winning value)", () => {
      const out = parseEffortKeywords([
        { role: "user", content: "[effortlevel:low] first" },
        { role: "user", content: "[effortlevel:high] second" },
      ]);
      expect(out.messages[0].content).not.toMatch(/effortlevel/);
      expect(out.messages[1].content).not.toMatch(/effortlevel/);
    });

    it("scopes detection to <USER_REQUEST> when present — ignores metadata messages with stray keywords", () => {
      // Reproduces the user-reported bug: Antigravity injects a "Conversation
      // History" block AFTER the USER_REQUEST. Past conversation titles in the
      // history embed `[effortlevel:xhigh]` literally (from earlier test
      // sessions), and the naive newest→oldest walk would pick xhigh up over
      // the user's actual current keyword (max), breaking on Opus 4.6.
      const out = parseEffortKeywords([
        { role: "user", content: "<user_information>...</user_information>" },
        { role: "user", content: "<USER_REQUEST>\nSalam [effortlevel:max]\n</USER_REQUEST>" },
        { role: "user", content: "# Conversation History\n## Conversation X: hey [effortlevel:max]\n## Conversation Y: hey [effortlevel:xhigh]" },
        { role: "user", content: "Knowledge items: ..." },
      ]);
      expect(out.effort).toBe("max");
      expect(out.fromKeyword.effort).toBe(true);
      // Keyword still stripped everywhere — history block becomes clean too.
      expect(out.messages[1].content).not.toMatch(/effortlevel/);
      expect(out.messages[2].content).not.toMatch(/effortlevel/);
    });

    it("scoping picks the latest USER_REQUEST across multi-turn conversations", () => {
      // Two USER_REQUEST turns; the newest one (turn 2) overrides the older.
      const out = parseEffortKeywords([
        { role: "user", content: "<USER_REQUEST>turn 1 [effortlevel:low]</USER_REQUEST>" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "<USER_REQUEST>turn 2 [effortlevel:high]</USER_REQUEST>" },
      ]);
      expect(out.effort).toBe("high");
    });

    it("legacy behavior preserved when no <USER_REQUEST> wrapper is present anywhere", () => {
      // Claude Code / raw OpenAI clients don't use the Antigravity wrapper —
      // they get the original "scan everything" behavior.
      const out = parseEffortKeywords([
        { role: "user", content: "first [effortlevel:low]" },
        { role: "user", content: "second [effortlevel:high]" },
      ]);
      expect(out.effort).toBe("high"); // newest wins
    });
  });
});

describe("openaiToClaudeRequest — emission per model class", () => {
  const baseBody = () => ({
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 8000,
  });

  describe("Opus 4.7 (adaptive-only, supports xhigh)", () => {
    it("emits adaptive thinking with no budget by default", () => {
      const out = openaiToClaudeRequest("claude-opus-4-7", baseBody(), true);
      expect(out.thinking).toEqual({ type: "adaptive" });
      expect(out.output_config).toBeUndefined();
    });

    it("attaches output_config.effort for xhigh", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[effortlevel:xhigh]" }] };
      const out = openaiToClaudeRequest("claude-opus-4-7", body, true);
      expect(out.output_config?.effort).toBe("xhigh");
      expect(out.thinking).toEqual({ type: "adaptive" });
    });

    it("rejects [thinkingbudget:N] — manual budget unsupported on Opus 4.7", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[thinkingbudget:8000]" }] };
      expect(() => openaiToClaudeRequest("claude-opus-4-7", body, true))
        .toThrow(EffortValidationError);
    });

    it("rejects explicit body.thinking.type:enabled", () => {
      const body = { ...baseBody(), thinking: { type: "enabled", budget_tokens: 8000 } };
      expect(() => openaiToClaudeRequest("claude-opus-4-7", body, true))
        .toThrow(EffortValidationError);
    });
  });

  describe("Opus 4.6 / Sonnet 4.6 (adaptive + effort + manual)", () => {
    it.each(["claude-opus-4-6", "claude-sonnet-4-6"])("emits adaptive by default — %s", (model) => {
      const out = openaiToClaudeRequest(model, baseBody(), true);
      expect(out.thinking).toEqual({ type: "adaptive" });
    });

    it.each(["claude-opus-4-6", "claude-sonnet-4-6"])("[effortlevel:max] accepted on %s", (model) => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[effortlevel:max]" }] };
      const out = openaiToClaudeRequest(model, body, true);
      expect(out.output_config?.effort).toBe("max");
    });

    it("rejects [effortlevel:xhigh] on Sonnet 4.6 (Opus 4.7-only)", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[effortlevel:xhigh]" }] };
      expect(() => openaiToClaudeRequest("claude-sonnet-4-6", body, true))
        .toThrow(EffortValidationError);
    });

    it("[thinkingbudget:N] downgrades to manual mode (still allowed)", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[thinkingbudget:12000]" }] };
      const out = openaiToClaudeRequest("claude-opus-4-6", body, true);
      expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
    });
  });

  describe("Opus 4.5 (effort + manual, no adaptive)", () => {
    it("emits manual budget thinking + output_config.effort together", () => {
      const body = {
        ...baseBody(),
        messages: [{ role: "user", content: "[effortlevel:high] [thinkingbudget:10000]" }],
      };
      const out = openaiToClaudeRequest("claude-opus-4-5", body, true);
      expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 10000 });
      expect(out.output_config?.effort).toBe("high");
    });

    it("rejects [effortlevel:max] on Opus 4.5 (not in its allowed set)", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[effortlevel:max]" }] };
      expect(() => openaiToClaudeRequest("claude-opus-4-5", body, true))
        .toThrow(EffortValidationError);
    });

    it("effort alone (no budget) still emits output_config.effort", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[effortlevel:medium]" }] };
      const out = openaiToClaudeRequest("claude-opus-4-5", body, true);
      expect(out.output_config?.effort).toBe("medium");
    });
  });

  describe("Budget-only models (Sonnet 4.5 / Haiku 4.5 / older Claude 4)", () => {
    it.each(["claude-sonnet-4-5", "claude-haiku-4-5", "claude-sonnet-4", "claude-opus-4-1"])(
      "rejects effort param on %s",
      (model) => {
        const body = { ...baseBody(), messages: [{ role: "user", content: "[effortlevel:high]" }] };
        expect(() => openaiToClaudeRequest(model, body, true))
          .toThrow(EffortValidationError);
      }
    );

    it("[thinkingbudget:N] accepted on Sonnet 4.5", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[thinkingbudget:8000]" }] };
      const out = openaiToClaudeRequest("claude-sonnet-4-5", body, true);
      expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
      expect(out.output_config).toBeUndefined();
    });

    it("reasoning_effort on older models translates to budget (legacy shim)", () => {
      const body = { ...baseBody(), reasoning_effort: "high" };
      const out = openaiToClaudeRequest("claude-sonnet-4-5", body, true);
      expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
    });
  });

  describe("Mythos Preview (adaptive default, effort, NO manual budget)", () => {
    it("emits adaptive thinking", () => {
      const out = openaiToClaudeRequest("claude-mythos-preview", baseBody(), true);
      expect(out.thinking).toEqual({ type: "adaptive" });
    });

    it("rejects [thinkingbudget:N] — manual not supported", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[thinkingbudget:8000]" }] };
      expect(() => openaiToClaudeRequest("claude-mythos-preview", body, true))
        .toThrow(EffortValidationError);
    });

    it("[effortlevel:max] accepted on Mythos", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[effortlevel:max]" }] };
      const out = openaiToClaudeRequest("claude-mythos-preview", body, true);
      expect(out.output_config?.effort).toBe("max");
    });

    it("rejects [effortlevel:xhigh] on Mythos (Opus 4.7 only)", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "[effortlevel:xhigh]" }] };
      expect(() => openaiToClaudeRequest("claude-mythos-preview", body, true))
        .toThrow(EffortValidationError);
    });
  });

  describe("Robustness", () => {
    it("strips unrecognized [effortlevel:bogus] from forwarded messages", () => {
      const body = { ...baseBody(), messages: [{ role: "user", content: "hey [effortlevel:bogus]" }] };
      const out = openaiToClaudeRequest("claude-opus-4-6", body, true);
      const userMsg = out.messages.find(m => m.role === "user");
      const text = Array.isArray(userMsg.content)
        ? userMsg.content.map(b => b.text || "").join("")
        : userMsg.content;
      expect(text).not.toMatch(/effortlevel/);
      expect(text.trim()).toBe("hey");
    });

    it("explicit body.thinking still wins (passthrough) when model supports it", () => {
      const body = { ...baseBody(), thinking: { type: "enabled", budget_tokens: 5000 } };
      const out = openaiToClaudeRequest("claude-sonnet-4-6", body, true);
      expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
    });

    it("alias-default effort is validated against the model on dispatch", () => {
      // Saved config from old session: effort=max on Opus 4.5 (which doesn't support max).
      // Should error at request time so user sees the problem.
      const body = { ...baseBody(), _9rEffortDefault: "max" };
      expect(() => openaiToClaudeRequest("claude-opus-4-5", body, true))
        .toThrow(EffortValidationError);
    });

    it("alias-default budget is validated against manualBudget capability", () => {
      const body = { ...baseBody(), _9rThinkingBudgetDefault: 8000 };
      expect(() => openaiToClaudeRequest("claude-opus-4-7", body, true))
        .toThrow(EffortValidationError);
    });

    it("unknown / non-Claude target — emits nothing thinking-related", () => {
      const body = { ...baseBody(), _9rEffortDefault: "high" };
      const out = openaiToClaudeRequest("gpt-4o", body, true);
      expect(out.thinking).toBeUndefined();
      expect(out.output_config).toBeUndefined();
    });
  });
});

describe("allowedEffortLevels", () => {
  it("returns the documented set per model", () => {
    expect([...allowedEffortLevels("claude-opus-4-7")]).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect([...allowedEffortLevels("claude-opus-4-6")]).toEqual(["low", "medium", "high", "max"]);
    expect([...allowedEffortLevels("claude-sonnet-4-6")]).toEqual(["low", "medium", "high", "max"]);
    expect([...allowedEffortLevels("claude-mythos-preview")]).toEqual(["low", "medium", "high", "max"]);
    expect([...allowedEffortLevels("claude-opus-4-5")]).toEqual(["low", "medium", "high"]);
    expect([...allowedEffortLevels("claude-sonnet-4-5")]).toEqual([]);
    expect([...allowedEffortLevels("gpt-4o")]).toEqual([]);
  });
});
