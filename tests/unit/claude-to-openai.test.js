import { describe, it, expect } from "vitest";

import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";

function createState() {
  return {
    toolCalls: new Map(),
    toolCallIndex: 0,
    serverToolBlockIndex: -1,
  };
}

function feed(events) {
  const state = createState();
  const chunks = [];
  for (const event of events) {
    const out = claudeToOpenAIResponse(event, state);
    if (out) chunks.push(...out);
  }
  return { state, chunks };
}

describe("claude-to-openai — thinking blocks", () => {
  it("emits thinking deltas only on reasoning_content, without visible <think> markers", () => {
    const { state, chunks } = feed([
      { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-4-6" } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "private reasoning" } },
      { type: "content_block_stop", index: 0 },
    ]);

    const visibleText = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.content || "")
      .join("");
    const reasoning = chunks
      .map((chunk) => chunk.choices?.[0]?.delta?.reasoning_content || "")
      .join("");

    expect(visibleText).not.toContain("<think>");
    expect(visibleText).not.toContain("</think>");
    expect(reasoning).toBe("private reasoning");
    expect(state.inThinkingBlock).toBe(false);
  });
});
