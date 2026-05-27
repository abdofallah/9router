import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/dataDir", () => ({ DATA_DIR: "C:/tmp/9router-test" }));

import {
  applyCodexReasoningConfig,
  isCodexProviderModel,
  parseCodexReasoningKeywords,
} from "../../open-sse/utils/codexReasoning.js";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";
import { CodexExecutor } from "../../open-sse/executors/codex.js";

describe("codexReasoning util", () => {
  it("scopes reasoning support to Codex provider routes only", () => {
    expect(isCodexProviderModel("cx/gpt-5.3-codex")).toBe(true);
    expect(isCodexProviderModel("openai/gpt-5.3-codex")).toBe(false);
    expect(isCodexProviderModel("gh/gpt-5.3-codex")).toBe(false);
    expect(isCodexProviderModel("gpt-5.3-codex")).toBe(false);
  });

  it("parses valid reasoninglevel tags and strips invalid tags", () => {
    expect(parseCodexReasoningKeywords("[reasoninglevel:high] solve")).toEqual({ level: "high", text: "solve" });
    expect(parseCodexReasoningKeywords("[reasoninglevel:max] solve")).toEqual({ level: null, text: "solve" });
  });

  it("applies tag override before alias default and strips prompt tags", () => {
    const body = {
      _9rReasoningDefault: "low",
      input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "[reasoninglevel:medium] hello" }] }],
    };

    applyCodexReasoningConfig(body, "cx/gpt-5.3-codex");

    expect(body.reasoning_effort).toBe("medium");
    expect(body.input[0].content[0].text).toBe("hello");
    expect(body._9rReasoningDefault).toBeUndefined();
  });

  it("does not apply or strip tags for non-Codex provider routes", () => {
    const body = { _9rReasoningDefault: "high", input: "[reasoninglevel:low] hello" };

    applyCodexReasoningConfig(body, "openai/gpt-5.3-codex");

    expect(body.reasoning_effort).toBeUndefined();
    expect(body.input).toBe("[reasoninglevel:low] hello");
    expect(body._9rReasoningDefault).toBe("high");
  });
});

describe("Codex reasoning request translation", () => {
  it("translates chat prompt tags into Responses API reasoning effort", () => {
    const result = openaiToOpenAIResponsesRequest("cx/gpt-5.3-codex", {
      messages: [{ role: "user", content: "[reasoninglevel:high] build it" }],
    }, true);

    expect(result.reasoning_effort).toBe("high");
    expect(result.input[0].content[0].text).toBe("build it");
  });

  it("Codex executor emits reasoning and include fields from default reasoning", () => {
    const executor = new CodexExecutor();
    const body = {
      model: "cx/gpt-5.3-codex",
      input: "hello",
      _9rReasoningDefault: "medium",
    };

    const result = executor.transformRequest("cx/gpt-5.3-codex", body, true, {});

    expect(result.model).toBe("cx/gpt-5.3-codex");
    expect(result.reasoning).toEqual({ effort: "medium", summary: "auto" });
    expect(result.include).toEqual(["reasoning.encrypted_content"]);
    expect(result._9rReasoningDefault).toBeUndefined();
  });
});
