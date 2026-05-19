import { register } from "../index.js";
import { FORMATS } from "../formats.js";
import { CLAUDE_SYSTEM_PROMPT } from "../../config/appConstants.js";
import { adjustMaxTokens } from "../helpers/maxTokensHelper.js";
import {
  EFFORT_TO_BUDGET,
  EffortValidationError,
  allowedEffortLevels,
  getEffortCapability,
  isAdaptiveThinkingModel,
  parseEffortKeywords,
  supportsEffort,
  supportsManualThinking,
} from "../../utils/claudeEffort.js";

// Empty prefix matches real Claude Code behavior (no tool name prefix).
// Previously "proxy_" was used but this is a detectable fingerprint difference.
const CLAUDE_OAUTH_TOOL_PREFIX = "";

// Convert OpenAI request to Claude format
export function openaiToClaudeRequest(model, body, stream) {
  // Tool name mapping for Claude OAuth (capitalizedName → originalName)
  const toolNameMap = new Map();
  const result = {
    model: model,
    max_tokens: adjustMaxTokens(body),
    stream: stream
  };

  // Temperature
  if (body.temperature !== undefined) {
    result.temperature = body.temperature;
  }

  // Effort/thinking pre-resolution: scan user messages for `[effortlevel:X]`
  // and `[thinkingbudget:N]` keywords, fall back to defaults stamped on the
  // body (e.g. by the MITM antigravity handler from per-alias config), and
  // strip the keywords from the messages we forward to the API.
  const effortDefaults = {
    effort: body._9rEffortDefault || body.output_config?.effort,
    budgetTokens: body._9rThinkingBudgetDefault || body.thinking?.budget_tokens,
  };
  // Coerce existing reasoning_effort into the default chain so we don't lose
  // it when keyword scanning runs. The numeric form (budget_tokens) wins over
  // reasoning_effort for older models — see the thinking emission block below.
  if (effortDefaults.effort === undefined && body.reasoning_effort) {
    const re = String(body.reasoning_effort).toLowerCase();
    if (re === "none") {
      effortDefaults.effort = undefined; // explicit opt-out
    } else if (["low", "medium", "high", "xhigh", "max"].includes(re)) {
      effortDefaults.effort = re;
    }
  }
  const parsed = parseEffortKeywords(body.messages, effortDefaults);
  if (Array.isArray(body.messages) && parsed.messages !== body.messages) {
    // Replace messages so downstream block-extraction sees the stripped text.
    body = { ...body, messages: parsed.messages };
  }
  const resolvedEffort = parsed.effort;
  const resolvedBudgetTokens = parsed.budgetTokens;

  // Validation policy — strict for explicit user intent, lenient for legacy
  // sources so OpenAI-style clients keep working:
  //
  //   STRICT (throws EffortValidationError):
  //     - [effortlevel:X] / [thinkingbudget:N] keyword in user text
  //     - body._9rEffortDefault / body._9rThinkingBudgetDefault (set by the
  //       MITM antigravity handler from per-alias dashboard config — the
  //       dashboard validates at save, so an invalid value here means the
  //       saved config went stale and the user should re-pick)
  //     - explicit body.thinking.type:"enabled" on a model that rejects it
  //
  //   LENIENT (silently dropped by the emission block):
  //     - body.reasoning_effort (OpenAI-format compatibility shim)
  //     - body.output_config.effort (already in Claude format — pass through)
  //
  // Unknown / non-Claude models (cap.class === null) skip all Claude-specific
  // emission anyway, so validation noops there.
  const cap = getEffortCapability(model);
  const effortFromKeyword = parsed.fromKeyword.effort;
  const budgetFromKeyword = parsed.fromKeyword.budget;
  const effortFromAliasDefault = body._9rEffortDefault !== undefined;
  const budgetFromAliasDefault = body._9rThinkingBudgetDefault !== undefined;
  const effortIsStrict = effortFromKeyword || effortFromAliasDefault;
  const budgetIsStrict = budgetFromKeyword || budgetFromAliasDefault;

  if (resolvedEffort && effortIsStrict && cap.class) {
    if (!cap.effort) {
      throw new EffortValidationError(
        `${model} does not support the effort parameter. Effort is available on Mythos, Opus 4.7, Opus 4.6, Sonnet 4.6, and Opus 4.5.${effortFromKeyword ? " Remove the [effortlevel:…] keyword or pick a different model." : ""}`
      );
    }
    const allowed = allowedEffortLevels(model);
    if (!allowed.has(resolvedEffort)) {
      throw new EffortValidationError(
        `[effortlevel:${resolvedEffort}] is not valid for ${model}. Allowed levels on this model: ${[...allowed].join(", ")}.`
      );
    }
  }

  if (resolvedBudgetTokens > 0 && budgetIsStrict && cap.class && !cap.manualBudget) {
    throw new EffortValidationError(
      `[thinkingbudget:${resolvedBudgetTokens}] is not allowed on ${model}. ${cap.adaptive ? "This model uses adaptive thinking — set [effortlevel:…] instead." : "Manual thinking budget is not supported on this model."}`
    );
  }

  // Explicit body.thinking.type:enabled on Mythos / Opus 4.7 → reject early so
  // we surface a clear error instead of the upstream 400.
  if (body.thinking?.type === "enabled" && cap.class && !cap.manualBudget) {
    throw new EffortValidationError(
      `Manual thinking (thinking.type:"enabled") is not allowed on ${model}. Use thinking.type:"adaptive"${cap.effort ? ' with output_config.effort' : ''} instead.`
    );
  }

  // Messages
  result.messages = [];
  const systemParts = [];

  if (body.messages && Array.isArray(body.messages)) {
    // Extract system messages
    for (const msg of body.messages) {
      if (msg.role === "system") {
        systemParts.push(typeof msg.content === "string" ? msg.content : extractTextContent(msg.content));
      }
    }

    // Filter out system messages for separate processing
    const nonSystemMessages = body.messages.filter(m => m.role !== "system");

    // Process messages with merging logic
    // CRITICAL: tool_result must be in separate message immediately after tool_use
    let currentRole = undefined;
    let currentParts = [];

    const flushCurrentMessage = () => {
      if (currentRole && currentParts.length > 0) {
        result.messages.push({ role: currentRole, content: currentParts });
        currentParts = [];
      }
    };

    for (const msg of nonSystemMessages) {
      const newRole = (msg.role === "user" || msg.role === "tool") ? "user" : "assistant";
      const blocks = getContentBlocksFromMessage(msg, toolNameMap);
      const hasToolUse = blocks.some(b => b.type === "tool_use");
      const hasToolResult = blocks.some(b => b.type === "tool_result");

      // Separate tool_result from other content
      if (hasToolResult) {
        const toolResultBlocks = blocks.filter(b => b.type === "tool_result");
        const otherBlocks = blocks.filter(b => b.type !== "tool_result");

        flushCurrentMessage();

        if (toolResultBlocks.length > 0) {
          result.messages.push({ role: "user", content: toolResultBlocks });
        }

        if (otherBlocks.length > 0) {
          currentRole = newRole;
          currentParts.push(...otherBlocks);
        }
        continue;
      }

      if (currentRole !== newRole) {
        flushCurrentMessage();
        currentRole = newRole;
      }

      currentParts.push(...blocks);

      if (hasToolUse) {
        flushCurrentMessage();
      }
    }

    flushCurrentMessage();

    // Add cache_control to last assistant message
    for (let i = result.messages.length - 1; i >= 0; i--) {
      const message = result.messages[i];
      if (message.role === "assistant" && Array.isArray(message.content) && message.content.length > 0) {
        // Find the last block that can have cache_control (not thinking blocks)
        const validBlockTypes = ["text", "tool_use", "tool_result", "image"];
        for (let j = message.content.length - 1; j >= 0; j--) {
          const block = message.content[j];
          if (validBlockTypes.includes(block.type)) {
            block.cache_control = { type: "ephemeral" };
            break;
          }
        }
        break;
      }
    }
  }

  // Handle response_format for JSON mode
  if (body.response_format) {
    const responseFormat = body.response_format;
    if (responseFormat.type === "json_schema" && responseFormat.json_schema?.schema) {
      const schemaJson = JSON.stringify(responseFormat.json_schema.schema, null, 2);
      systemParts.push(`You must respond with valid JSON that strictly follows this JSON schema:
\`\`\`json
${schemaJson}
\`\`\`
Respond ONLY with the JSON object, no other text.`);
    } else if (responseFormat.type === "json_object") {
      systemParts.push("You must respond with valid JSON. Respond ONLY with a JSON object, no other text.");
    }
  }

  // System with Claude Code prompt and cache_control
  const claudeCodePrompt = { type: "text", text: CLAUDE_SYSTEM_PROMPT };

  if (systemParts.length > 0) {
    const systemText = systemParts.join("\n");
    result.system = [
      claudeCodePrompt,
      { type: "text", text: systemText, cache_control: { type: "ephemeral", ttl: "1h" } }
    ];
  } else {
    result.system = [claudeCodePrompt];
  }

  // Tools - convert from OpenAI format to Claude format with prefix for OAuth
  if (body.tools && Array.isArray(body.tools)) {
    result.tools = [];
    for (const tool of body.tools) {
      // Pass-through built-in tools (e.g. web_search_20250305) without prefix or conversion
      const toolType = tool.type;
      if (toolType && toolType !== "function") {
        result.tools.push(tool);
        continue;
      }

      const toolData = toolType === "function" && tool.function ? tool.function : tool;
      const originalName = toolData.name;

      // Claude OAuth requires prefixed tool names to avoid conflicts
      const toolName = CLAUDE_OAUTH_TOOL_PREFIX + originalName;

      // Store mapping for response translation (prefixed → original)
      toolNameMap.set(toolName, originalName);

      result.tools.push({
        name: toolName,
        description: toolData.description || "",
        input_schema: toolData.parameters || toolData.input_schema || { type: "object", properties: {}, required: [] }
      });
    }

    if (result.tools.length > 0) {
      result.tools[result.tools.length - 1].cache_control = { type: "ephemeral", ttl: "1h" };
    }
  }

  // Tool choice
  if (body.tool_choice) {
    result.tool_choice = convertOpenAIToolChoice(body.tool_choice);
  }

  // Thinking + effort emission — driven by the per-model capability matrix.
  //
  //   Adaptive-capable (Mythos, Opus 4.7, Opus 4.6, Sonnet 4.6):
  //     thinking: { type: "adaptive" } unless [thinkingbudget:N] explicitly
  //     requested (and model also supports manual — Opus 4.7 doesn't, so the
  //     validator above already rejected). output_config.effort attached when
  //     a level is set.
  //
  //   Effort + manual (Opus 4.5 only):
  //     thinking: { type: "enabled", budget_tokens: N }
  //     output_config: { effort } — both fields coexist on Opus 4.5.
  //
  //   Budget-only (Sonnet 4.5 / Haiku 4.5 / older Claude 4):
  //     thinking: { type: "enabled", budget_tokens: N }
  //     No output_config.effort. Effort hints from reasoning_effort are
  //     translated to a budget via EFFORT_TO_BUDGET as a legacy shim.
  //
  //   Unknown / non-Claude: emit nothing — the upstream provider may have its
  //   own handling.
  //
  // An explicit body.thinking still wins (validated above so we only see
  // model-compatible payloads here).

  if (body.thinking) {
    result.thinking = {
      type: body.thinking.type || "enabled",
      ...(body.thinking.budget_tokens && { budget_tokens: body.thinking.budget_tokens }),
      ...(body.thinking.max_tokens && { max_tokens: body.thinking.max_tokens })
    };
  } else if (cap.adaptive && !(resolvedBudgetTokens > 0)) {
    // Adaptive-capable model + no explicit budget → adaptive thinking.
    result.thinking = { type: "adaptive" };
  } else if (resolvedBudgetTokens > 0 && cap.manualBudget) {
    // Explicit budget request on a model that supports manual thinking.
    result.thinking = { type: "enabled", budget_tokens: resolvedBudgetTokens };
  } else if (resolvedEffort && cap.manualBudget && !cap.effort) {
    // Budget-only Claude (e.g. Sonnet 4.5, Haiku 4.5): translate effort hint
    // into an equivalent budget so OpenAI-style reasoning_effort works.
    const budget = EFFORT_TO_BUDGET[resolvedEffort];
    if (budget) result.thinking = { type: "enabled", budget_tokens: budget };
  }

  // output_config.effort — attached only on effort-supporting models, only
  // when the resolved level is in that model's allowed set (validated above).
  if (resolvedEffort && cap.effort) {
    result.output_config = { ...(result.output_config || {}), effort: resolvedEffort };
  }

  // Attach toolNameMap to result for response translation
  if (toolNameMap.size > 0) {
    result._toolNameMap = toolNameMap;
  }

  return result;
}

// Get content blocks from single message
function getContentBlocksFromMessage(msg, toolNameMap = new Map()) {
  const blocks = [];

  if (msg.role === "tool") {
    blocks.push({
      type: "tool_result",
      tool_use_id: msg.tool_call_id,
      content: msg.content
    });
  } else if (msg.role === "user") {
    if (typeof msg.content === "string") {
      if (msg.content) {
        blocks.push({ type: "text", text: msg.content });
      }
    } else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "tool_result") {
          blocks.push({
            type: "tool_result",
            tool_use_id: part.tool_use_id,
            content: part.content,
            ...(part.is_error && { is_error: part.is_error })
          });
        } else if (part.type === "image_url") {
          const url = part.image_url.url;
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            blocks.push({
              type: "image",
              source: { type: "base64", media_type: match[1], data: match[2] }
            });
          } else if (url.startsWith("http://") || url.startsWith("https://")) {
            blocks.push({
              type: "image",
              source: { type: "url", url }
            });
          }
        } else if (part.type === "image" && part.source) {
          blocks.push({ type: "image", source: part.source });
        }
      }
    }
  } else if (msg.role === "assistant") {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text" && part.text) {
          blocks.push({ type: "text", text: part.text });
        } else if (part.type === "tool_use") {
          // Tool name already has prefix from tool declarations, keep as-is
          blocks.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
        } else if (part.type === "thinking") {
          // Include thinking block but strip cache_control (not allowed on thinking blocks)
          const { cache_control, ...thinkingBlock } = part;
          blocks.push(thinkingBlock);
        }
      }
    } else if (msg.content) {
      const text = typeof msg.content === "string" ? msg.content : extractTextContent(msg.content);
      if (text) {
        blocks.push({ type: "text", text });
      }
    }

    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        if (tc.type === "function") {
          // Apply prefix to tool name
          const toolName = CLAUDE_OAUTH_TOOL_PREFIX + tc.function.name;
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: toolName,
            input: tryParseJSON(tc.function.arguments)
          });
        }
      }
    }
  }

  return blocks;
}

// Convert OpenAI tool choice to Claude format
function convertOpenAIToolChoice(choice) {
  if (!choice) return { type: "auto" };
  if (typeof choice === "object" && choice.type) return choice;
  if (choice === "auto" || choice === "none") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (typeof choice === "object" && choice.function) {
    return { type: "tool", name: choice.function.name };
  }
  return { type: "auto" };
}

// Extract text from content
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === "text").map(c => c.text).join("\n");
  }
  return "";
}

// Try parse JSON
function tryParseJSON(str) {
  if (typeof str !== "string") return str;
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// OpenAI -> Claude format for Antigravity (without system prompt modifications)
function openaiToClaudeRequestForAntigravity(model, body, stream) {
  const result = openaiToClaudeRequest(model, body, stream);

  // Remove Claude Code system prompt, keep only user's system messages
  if (result.system && Array.isArray(result.system)) {
    result.system = result.system.filter(block =>
      !block.text || !block.text.includes("You are Claude Code")
    );
    if (result.system.length === 0) {
      delete result.system;
    }
  }

  // Strip prefix from tool names for Antigravity (doesn't use Claude OAuth)
  if (result.tools && Array.isArray(result.tools)) {
    result.tools = result.tools.map(tool => {
      if (tool.name && tool.name.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
        return {
          ...tool,
          name: tool.name.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
        };
      }
      return tool;
    });
  }

  // Strip prefix from tool_use in messages
  if (result.messages && Array.isArray(result.messages)) {
    result.messages = result.messages.map(msg => {
      if (!msg.content || !Array.isArray(msg.content)) {
        return msg;
      }

      const updatedContent = msg.content.map(block => {
        if (block.type === "tool_use" && block.name && block.name.startsWith(CLAUDE_OAUTH_TOOL_PREFIX)) {
          return {
            ...block,
            name: block.name.slice(CLAUDE_OAUTH_TOOL_PREFIX.length)
          };
        }
        return block;
      });

      return { ...msg, content: updatedContent };
    });
  }

  return result;
}

// Export for use in other translators
export { openaiToClaudeRequestForAntigravity };

// Register
register(FORMATS.OPENAI, FORMATS.CLAUDE, openaiToClaudeRequest, null);

