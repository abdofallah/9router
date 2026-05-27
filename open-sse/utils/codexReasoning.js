const CODEX_REASONING_LEVEL_RE = /\[reasoninglevel:(low|medium|high)\]/gi;
const CODEX_REASONING_LEVEL_STRIP_RE = /\[reasoninglevel:[^\]\n]*\]/gi;

export const allowedCodexReasoningLevels = ["low", "medium", "high"];

export function isCodexProviderModel(model) {
  return typeof model === "string" && model.toLowerCase().startsWith("cx/");
}

export function normalizeCodexReasoningLevel(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return allowedCodexReasoningLevels.includes(normalized) ? normalized : null;
}

export function parseCodexReasoningKeywords(text) {
  if (typeof text !== "string" || !text) return { level: null, text };

  let level = null;
  CODEX_REASONING_LEVEL_RE.lastIndex = 0;
  let match;
  while ((match = CODEX_REASONING_LEVEL_RE.exec(text)) !== null) {
    level = normalizeCodexReasoningLevel(match[1]) || level;
  }

  CODEX_REASONING_LEVEL_STRIP_RE.lastIndex = 0;
  if (!level && !CODEX_REASONING_LEVEL_STRIP_RE.test(text)) {
    CODEX_REASONING_LEVEL_STRIP_RE.lastIndex = 0;
    return { level: null, text };
  }
  CODEX_REASONING_LEVEL_STRIP_RE.lastIndex = 0;
  return {
    level,
    text: text.replace(CODEX_REASONING_LEVEL_STRIP_RE, "").replace(/[ \t]+\n/g, "\n").trim(),
  };
}

function stripFromContent(content) {
  let level = null;

  if (typeof content === "string") {
    const parsed = parseCodexReasoningKeywords(content);
    return { level: parsed.level, content: parsed.text };
  }

  if (!Array.isArray(content)) return { level: null, content };

  const next = content.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return part;
    const textKey = typeof part.text === "string" ? "text" : null;
    if (!textKey) return part;
    const parsed = parseCodexReasoningKeywords(part[textKey]);
    if (parsed.level) level = parsed.level;
    return { ...part, [textKey]: parsed.text };
  });

  return { level, content: next };
}

export function applyCodexReasoningConfig(body, model) {
  if (!isCodexProviderModel(model) || !body || typeof body !== "object") return body;

  let taggedLevel = null;
  if (Array.isArray(body.input)) {
    body.input = body.input.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const role = item.role;
      if (role && role !== "user") return item;
      const stripped = stripFromContent(item.content);
      if (stripped.level) taggedLevel = stripped.level;
      return stripped.content === item.content ? item : { ...item, content: stripped.content };
    });
  } else if (typeof body.input === "string") {
    const parsed = parseCodexReasoningKeywords(body.input);
    if (parsed.level) taggedLevel = parsed.level;
    body.input = parsed.text;
  }

  const defaultLevel = normalizeCodexReasoningLevel(body._9rReasoningDefault);
  const level = taggedLevel || defaultLevel;
  if (level && !(body.reasoning && body.reasoning.effort)) {
    body.reasoning_effort = level;
  }

  delete body._9rReasoningDefault;
  return body;
}
