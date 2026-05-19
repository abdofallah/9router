import { describe, it, expect } from "vitest";

import {
  EffortValidationError,
  isAdaptiveThinkingModel,
  parseEffortKeywords,
  supportsMaxEffort,
  supportsXHighEffort,
} from "../../open-sse/utils/claudeEffort.js";
import { openaiToClaudeRequest } from "../../open-sse/translator/request/openai-to-claude.js";

describe("claudeEffort util", () => {
  describe("model gates", () => {
    it("isAdaptiveThinkingModel recognizes modern Claude 4.6+ models", () => {
      expect(isAdaptiveThinkingModel("claude-opus-4-6")).toBe(true);
      expect(isAdaptiveThinkingModel("claude-sonnet-4-6")).toBe(true);
      expect(isAdaptiveThinkingModel("claude-opus-4-7")).toBe(true);
      expect(isAdaptiveThinkingModel("cc/claude-opus-4-6")).toBe(true);
    });

    it("isAdaptiveThinkingModel rejects older models", () => {
      expect(isAdaptiveThinkingModel("claude-sonnet-4")).toBe(false);
      expect(isAdaptiveThinkingModel("claude-haiku-4-5")).toBe(false);
      expect(isAdaptiveThinkingModel("claude-opus-4")).toBe(false);
      expect(isAdaptiveThinkingModel("")).toBe(false);
      expect(isAdaptiveThinkingModel(null)).toBe(false);
    });

    it("supportsMaxEffort allows Opus 4.6+ and Sonnet 4.6+ per the effort spec", () => {
      expect(supportsMaxEffort("claude-opus-4-6")).toBe(true);
      expect(supportsMaxEffort("claude-opus-4-7")).toBe(true);
      expect(supportsMaxEffort("claude-sonnet-4-6")).toBe(true);
      expect(supportsMaxEffort("claude-mythos-preview")).toBe(true);
      expect(supportsMaxEffort("claude-haiku-4-5")).toBe(false);
      expect(supportsMaxEffort("claude-opus-4")).toBe(false);
      expect(supportsMaxEffort("claude-sonnet-4")).toBe(false);
    });

    it("supportsXHighEffort restricts to Opus 4.7+", () => {
      expect(supportsXHighEffort("claude-opus-4-7")).toBe(true);
      expect(supportsXHighEffort("claude-opus-4-8")).toBe(true);
      expect(supportsXHighEffort("claude-opus-4-6")).toBe(false);
      expect(supportsXHighEffort("claude-sonnet-4-6")).toBe(false);
      expect(supportsXHighEffort("claude-sonnet-4-7")).toBe(false);
    });
  });

  describe("parseEffortKeywords", () => {
    it("returns defaults when no keyword present", () => {
      const out = parseEffortKeywords([{ role: "user", content: "hello" }], { effort: "medium" });
      expect(out.effort).toBe("medium");
      expect(out.matched).toBe(false);
      expect(out.messages[0].content).toBe("hello");
    });

    it("captures [effortlevel:high] and strips it from the message", () => {
      const out = parseEffortKeywords([{ role: "user", content: "do the thing [effortlevel:high] please" }]);
      expect(out.effort).toBe("high");
      expect(out.matched).toBe(true);
      expect(out.messages[0].content).toBe("do the thing  please".replace(/  /, " "));
    });

    it("captures [effortlevel:xhigh] as its own value (not as alias for max)", () => {
      const out = parseEffortKeywords([{ role: "user", content: "[effortlevel:xhigh] reason" }]);
      expect(out.effort).toBe("xhigh");
    });

    it("strips unknown [effortlevel:foo] tokens even if value is unrecognized", () => {
      const out = parseEffortKeywords([{ role: "user", content: "hey [effortlevel:gibberish]" }]);
      expect(out.effort).toBeUndefined(); // no valid match → no override
      expect(out.messages[0].content).toBe("hey"); // but still cleaned from prompt
    });

    it("strips unknown [thinkingbudget:abc] tokens", () => {
      const out = parseEffortKeywords([{ role: "user", content: "go [thinkingbudget:not-a-number] now" }]);
      expect(out.budgetTokens).toBeUndefined();
      expect(out.messages[0].content).toBe("go  now".replace(/  /, " "));
    });

    it("cleans the Antigravity USER_REQUEST wrapper without leaving trailing space", () => {
      // Reproduces the user-reported case where the keyword sat at end-of-line
      // inside <USER_REQUEST>\n...\n</USER_REQUEST>.
      const wrapped = "<USER_REQUEST>\nhey [effortlevel:xhigh]\n</USER_REQUEST>\n<META>x</META>";
      const out = parseEffortKeywords([{ role: "user", content: wrapped }]);
      expect(out.effort).toBe("xhigh");
      expect(out.messages[0].content).toBe("<USER_REQUEST>\nhey\n</USER_REQUEST>\n<META>x</META>");
    });

    it("captures [thinkingbudget:8192] and strips it", () => {
      const out = parseEffortKeywords([{ role: "user", content: "[thinkingbudget:8192] start" }]);
      expect(out.budgetTokens).toBe(8192);
      expect(out.messages[0].content).toBe("start");
    });

    it("latest user message wins per dimension", () => {
      const out = parseEffortKeywords([
        { role: "user", content: "[effortlevel:low] first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "[effortlevel:max] second" },
      ]);
      expect(out.effort).toBe("max");
    });

    it("dimensions resolve independently across messages", () => {
      // effort comes from turn 3, budget from turn 1 — both should stick.
      const out = parseEffortKeywords([
        { role: "user", content: "go [thinkingbudget:12000] please" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "now [effortlevel:high]" },
      ]);
      expect(out.effort).toBe("high");
      expect(out.budgetTokens).toBe(12000);
    });

    it("strips keywords from ALL user messages, not just the matching one", () => {
      const out = parseEffortKeywords([
        { role: "user", content: "[effortlevel:low] first" },
        { role: "user", content: "[effortlevel:high] second" },
      ]);
      expect(out.messages[0].content).not.toMatch(/effortlevel/);
      expect(out.messages[1].content).not.toMatch(/effortlevel/);
    });

    it("does not touch assistant content", () => {
      const out = parseEffortKeywords([
        { role: "assistant", content: "I would set [effortlevel:high] but won't" },
        { role: "user", content: "hi" },
      ]);
      expect(out.effort).toBeUndefined();
      expect(out.messages[0].content).toContain("[effortlevel:high]");
    });

    it("handles array-form content blocks", () => {
      const out = parseEffortKeywords([
        {
          role: "user",
          content: [
            { type: "text", text: "begin [effortlevel:medium]" },
            { type: "text", text: "extra context" },
          ],
        },
      ]);
      expect(out.effort).toBe("medium");
      expect(out.messages[0].content[0].text).toBe("begin");
      expect(out.messages[0].content[1].text).toBe("extra context");
    });
  });
});

describe("openaiToClaudeRequest — effort/thinking wiring", () => {
  const baseBody = () => ({
    messages: [{ role: "user", content: "hello" }],
    max_tokens: 8000,
  });

  it("emits adaptive thinking for modern Claude models without explicit effort", () => {
    const out = openaiToClaudeRequest("claude-opus-4-6", baseBody(), true);
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toBeUndefined();
  });

  it("attaches output_config.effort when alias default is set", () => {
    const body = { ...baseBody(), _9rEffortDefault: "medium" };
    const out = openaiToClaudeRequest("claude-opus-4-6", body, true);
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "medium" });
  });

  it("[effortlevel:high] keyword overrides alias default", () => {
    const body = {
      ...baseBody(),
      messages: [{ role: "user", content: "go deep [effortlevel:high]" }],
      _9rEffortDefault: "medium",
    };
    const out = openaiToClaudeRequest("claude-opus-4-6", body, true);
    expect(out.output_config.effort).toBe("high");
    expect(out.messages[0].content[0].text).not.toMatch(/effortlevel/);
  });

  it("rejects [effortlevel:max] for older models that don't support it", () => {
    // Per the effort spec, max requires Opus 4.6+, Sonnet 4.6+, or Mythos. Older
    // sonnets/haikus still get rejected.
    const body = {
      ...baseBody(),
      messages: [{ role: "user", content: "[effortlevel:max]" }],
    };
    expect(() => openaiToClaudeRequest("claude-haiku-4-5", body, true))
      .toThrow(EffortValidationError);
    expect(() => openaiToClaudeRequest("claude-sonnet-4", body, true))
      .toThrow(EffortValidationError);
  });

  it("allows [effortlevel:max] on Sonnet 4.6 (per the effort spec)", () => {
    const body = {
      ...baseBody(),
      messages: [{ role: "user", content: "[effortlevel:max] go" }],
    };
    const out = openaiToClaudeRequest("claude-sonnet-4-6", body, true);
    expect(out.output_config.effort).toBe("max");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("allows [effortlevel:max] for Opus 4.6", () => {
    const body = {
      ...baseBody(),
      messages: [{ role: "user", content: "[effortlevel:max] reason hard" }],
    };
    const out = openaiToClaudeRequest("claude-opus-4-6", body, true);
    expect(out.output_config.effort).toBe("max");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("rejects [effortlevel:xhigh] on Opus 4.6 (Opus 4.7-only)", () => {
    const body = {
      ...baseBody(),
      messages: [{ role: "user", content: "[effortlevel:xhigh]" }],
    };
    expect(() => openaiToClaudeRequest("claude-opus-4-6", body, true))
      .toThrow(EffortValidationError);
  });

  it("allows [effortlevel:xhigh] on Opus 4.7", () => {
    const body = {
      ...baseBody(),
      messages: [{ role: "user", content: "[effortlevel:xhigh] long task" }],
    };
    const out = openaiToClaudeRequest("claude-opus-4-7", body, true);
    expect(out.output_config.effort).toBe("xhigh");
    expect(out.thinking).toEqual({ type: "adaptive" });
  });

  it("strips unrecognized keyword values from forwarded messages", () => {
    // Reproduces user-reported bug: [effortlevel:xhigh] on a build that didn't
    // know xhigh leaked the literal text through to the API. The permissive
    // strip ensures the keyword never reaches Claude, even when unrecognized.
    const body = {
      ...baseBody(),
      messages: [{ role: "user", content: "hey [effortlevel:bogus]" }],
    };
    const out = openaiToClaudeRequest("claude-sonnet-4-6", body, true);
    const userMsg = out.messages.find(m => m.role === "user");
    const text = Array.isArray(userMsg.content)
      ? userMsg.content.map(b => b.text || "").join("")
      : userMsg.content;
    expect(text).not.toMatch(/effortlevel/);
    expect(text.trim()).toBe("hey");
  });

  it("[thinkingbudget:N] forces budget-based thinking even on adaptive-capable models", () => {
    const body = {
      ...baseBody(),
      messages: [{ role: "user", content: "[thinkingbudget:12000] reason" }],
    };
    const out = openaiToClaudeRequest("claude-opus-4-6", body, true);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 12000 });
  });

  it("older models get budget-based thinking with effort→budget mapping", () => {
    const body = { ...baseBody(), _9rEffortDefault: "high" };
    const out = openaiToClaudeRequest("claude-sonnet-4", body, true);
    expect(out.thinking?.type).toBe("enabled");
    expect(out.thinking?.budget_tokens).toBe(16384);
    expect(out.output_config).toBeUndefined();
  });

  it("explicit body.thinking takes precedence over keyword/default heuristics", () => {
    const body = {
      ...baseBody(),
      thinking: { type: "enabled", budget_tokens: 5000 },
      messages: [{ role: "user", content: "[effortlevel:high] go" }],
    };
    const out = openaiToClaudeRequest("claude-opus-4-6", body, true);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 5000 });
    // output_config.effort still attaches because the keyword was valid for this model
    expect(out.output_config?.effort).toBe("high");
  });

  it("respects [thinkingbudget:N] from latest user message even with older alias-default", () => {
    const body = {
      ...baseBody(),
      messages: [
        { role: "user", content: "warm up" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "[thinkingbudget:4096] go" },
      ],
      _9rThinkingBudgetDefault: 16384,
    };
    const out = openaiToClaudeRequest("claude-sonnet-4", body, true);
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
  });
});
