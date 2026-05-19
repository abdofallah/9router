// Claude effort & thinking helpers — strict implementation of the published API.
//
// Sources of truth:
//   - platform.claude.com/docs/en/build-with-claude/effort
//   - platform.claude.com/docs/en/build-with-claude/adaptive-thinking
//   - platform.claude.com/docs/en/build-with-claude/extended-thinking
//
// The three dimensions, summarised per model class:
//
//   class           effort? levels                    adaptive  manualBudget   notes
//   mythos          yes     low/medium/high/max       yes (def) NO             type:enabled is unsupported
//   opus-4-7        yes     low/medium/high/xhigh/max yes       NO             type:enabled → 400
//   opus-4-6        yes     low/medium/high/max       yes       deprecated/ok  manual still works but soft-deprecated
//   sonnet-4-6      yes     low/medium/high/max       yes       deprecated/ok
//   opus-4-5        yes     low/medium/high           NO        yes            effort works alongside manual budget
//   sonnet-4-5      no      —                         no        yes            budget only
//   haiku-4-5       no      —                         no        yes            budget only
//   opus-4-1        no      —                         no        yes            budget only
//   opus-4          no      —                         no        yes            budget only
//   sonnet-4        no      —                         no        yes            budget only
//   sonnet-3-7      no      —                         no        yes            budget only
//   (unknown)       no      —                         no        no             safe default — emit nothing
//
// Plus a 9router-specific UX shortcut: users override per-message via
//   [effortlevel:low|medium|high|xhigh|max]   → output_config.effort
//   [thinkingbudget:N]                        → thinking: { type: "enabled", budget_tokens: N }

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Fallback effort→budget mapping. Used as a legacy reasoning_effort shim for
// older Claude models that accept manual budget thinking but not the effort
// parameter — so OpenAI-style clients sending reasoning_effort: "high" still
// produce a sensible request body.
export const EFFORT_TO_BUDGET = {
  low: 4096,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32768,
};

// ── Model class detection ─────────────────────────────────────────────────
//
// Matches case-insensitive substrings so vendor prefixes (`cc/`, `anthropic/`,
// `claude-compat/...`) and date suffixes (`-20251001`) all resolve correctly.
// Order matters — more specific patterns (opus-4-7) must precede less specific
// ones (opus-4) so 4.7 isn't accidentally classified as plain "opus-4".
const MODEL_CLASS_PATTERNS = [
  ["mythos",     /mythos/i],
  ["opus-4-7",   /opus-4-7/i],
  ["opus-4-6",   /opus-4-6/i],
  ["opus-4-5",   /opus-4-5/i],
  ["opus-4-1",   /opus-4-1/i],
  ["sonnet-4-6", /sonnet-4-6/i],
  ["sonnet-4-5", /sonnet-4-5/i],
  ["haiku-4-5",  /haiku-4-5/i],
  ["sonnet-3-7", /sonnet-3[.-]7/i],
  // Plain `opus-4` / `sonnet-4` must come AFTER the dotted variants so
  // `opus-4-6` doesn't accidentally classify as `opus-4`.
  ["opus-4",     /opus-4(?!-?\d)/i],
  ["sonnet-4",   /sonnet-4(?!-?\d)/i],
];

export function getClaudeModelClass(model) {
  if (!model || typeof model !== "string") return null;
  for (const [klass, re] of MODEL_CLASS_PATTERNS) {
    if (re.test(model)) return klass;
  }
  return null;
}

// ── Capability gates ──────────────────────────────────────────────────────

// Models that accept `output_config.effort`.
const EFFORT_MODELS = new Set(["mythos", "opus-4-7", "opus-4-6", "sonnet-4-6", "opus-4-5"]);

// Models that accept `thinking: { type: "adaptive" }`.
const ADAPTIVE_MODELS = new Set(["mythos", "opus-4-7", "opus-4-6", "sonnet-4-6"]);

// Models that accept `thinking: { type: "enabled", budget_tokens: N }`.
// Excludes Mythos (no manual mode) and Opus 4.7 (manual is rejected with 400).
const MANUAL_THINKING_MODELS = new Set([
  "opus-4-6", "sonnet-4-6", "opus-4-5", "sonnet-4-5", "haiku-4-5",
  "opus-4-1", "opus-4", "sonnet-4", "sonnet-3-7",
]);

// Effort levels accepted per class. Levels not in the set are rejected.
const ALLOWED_LEVELS = {
  "mythos":     new Set(["low", "medium", "high", "max"]),
  "opus-4-7":   new Set(["low", "medium", "high", "xhigh", "max"]),
  "opus-4-6":   new Set(["low", "medium", "high", "max"]),
  "sonnet-4-6": new Set(["low", "medium", "high", "max"]),
  "opus-4-5":   new Set(["low", "medium", "high"]),
};

export function supportsEffort(model) {
  return EFFORT_MODELS.has(getClaudeModelClass(model));
}

export function isAdaptiveThinkingModel(model) {
  return ADAPTIVE_MODELS.has(getClaudeModelClass(model));
}

export function supportsManualThinking(model) {
  return MANUAL_THINKING_MODELS.has(getClaudeModelClass(model));
}

export function allowedEffortLevels(model) {
  return ALLOWED_LEVELS[getClaudeModelClass(model)] || new Set();
}

export function supportsMaxEffort(model) {
  return allowedEffortLevels(model).has("max");
}

export function supportsXHighEffort(model) {
  return allowedEffortLevels(model).has("xhigh");
}

// Composite capability summary — what the dashboard renders against.
//
// Shape: {
//   class: string|null,        // detected model class id, or null if non-Claude/unknown
//   supported: boolean,        // any Claude support at all (effort OR manualBudget)
//   effort: boolean,           // show Effort dropdown?
//   levels: string[],          // ordered list of effort options to show
//   adaptive: boolean,         // model uses adaptive thinking by default
//   manualBudget: boolean,     // show Budget input?
// }
export function getEffortCapability(model) {
  const klass = getClaudeModelClass(model);
  const effort = EFFORT_MODELS.has(klass);
  const adaptive = ADAPTIVE_MODELS.has(klass);
  const manualBudget = MANUAL_THINKING_MODELS.has(klass);
  const levels = ALLOWED_LEVELS[klass] ? EFFORT_LEVELS.filter(l => ALLOWED_LEVELS[klass].has(l)) : [];
  return {
    class: klass,
    supported: effort || manualBudget,
    effort,
    levels,
    adaptive,
    manualBudget,
  };
}

// ── Keyword parsing ───────────────────────────────────────────────────────
//
// Two-tier regexes — strict for capturing valid values, permissive for
// stripping. The permissive strip removes ANY `[effortlevel:X]` /
// `[thinkingbudget:N]` token regardless of validity so typos never leak into
// the prompt forwarded to Claude.
const EFFORT_RE        = /\[effortlevel:(low|medium|high|xhigh|max)\]/gi;
const BUDGET_RE        = /\[thinkingbudget:(\d{2,7})\]/gi;
const EFFORT_STRIP_RE  = /\[effortlevel:[^\]\n]*\]/gi;
const BUDGET_STRIP_RE  = /\[thinkingbudget:[^\]\n]*\]/gi;

function stripKeywords(text) {
  if (!text) return text;
  return text
    .replace(EFFORT_STRIP_RE, "")
    .replace(BUDGET_STRIP_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .trim();
}

function lastKeywordsIn(text) {
  if (!text || typeof text !== "string") return {};
  let effort;
  let budgetTokens;

  EFFORT_RE.lastIndex = 0;
  for (const m of text.matchAll(EFFORT_RE)) effort = m[1].toLowerCase();

  BUDGET_RE.lastIndex = 0;
  for (const m of text.matchAll(BUDGET_RE)) budgetTokens = parseInt(m[1], 10);

  return { effort, budgetTokens };
}

function cleanUserContent(content) {
  if (typeof content === "string") return stripKeywords(content);
  if (!Array.isArray(content)) return content;
  return content.map(block => {
    if (block && block.type === "text" && typeof block.text === "string") {
      return { ...block, text: stripKeywords(block.text) };
    }
    return block;
  });
}

function userTextOf(msg) {
  if (!msg || msg.role !== "user") return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter(b => b && b.type === "text" && typeof b.text === "string")
      .map(b => b.text)
      .join("\n");
  }
  return "";
}

// Antigravity wraps every user-typed prompt in <USER_REQUEST>...</USER_REQUEST>
// and tacks metadata blocks (user_information, # Conversation History,
// knowledge items) on as separate user messages around it. Past conversation
// titles embedded in those metadata blocks can contain literal [effortlevel:X]
// keywords from earlier sessions — picking them up would override the user's
// real current keyword.
//
// When the wrapper is present anywhere in the conversation, narrow keyword
// detection to ONLY the inside of <USER_REQUEST>...</USER_REQUEST> blocks.
// Clients that don't use the wrapper (Claude Code, raw OpenAI) keep the
// legacy "scan everything" behaviour.
const USER_REQUEST_RE = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i;

function hasUserRequestWrapper(messages) {
  for (const m of messages) {
    if (!m || m.role !== "user") continue;
    if (USER_REQUEST_RE.test(userTextOf(m))) return true;
  }
  return false;
}

function detectionTextOf(msg, scopeToWrapper) {
  const raw = userTextOf(msg);
  if (!raw) return "";
  if (!scopeToWrapper) return raw;
  const match = raw.match(USER_REQUEST_RE);
  return match ? match[1] : ""; // metadata messages excluded from detection
}

/**
 * Scan messages newest→oldest for effort/budget keywords and return the
 * latest match. Always strips keywords from EVERY user message (regardless
 * of which one provided the winning value) AND regardless of value validity
 * (the permissive strip removes typos too).
 *
 * @param {Array} messages - OpenAI-format messages
 * @param {object} [defaults] - { effort?, budgetTokens? } fallback if no keyword found
 * @returns {{ effort?, budgetTokens?, messages, matched, fromKeyword: {effort,budget} }}
 */
export function parseEffortKeywords(messages, defaults = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      effort: defaults.effort,
      budgetTokens: defaults.budgetTokens,
      messages: messages || [],
      matched: false,
      fromKeyword: { effort: false, budget: false },
    };
  }

  let effort;
  let budgetTokens;
  const fromKeyword = { effort: false, budget: false };
  const scopeToWrapper = hasUserRequestWrapper(messages);

  for (let i = messages.length - 1; i >= 0; i--) {
    if (effort !== undefined && budgetTokens !== undefined) break;
    const text = detectionTextOf(messages[i], scopeToWrapper);
    if (!text) continue;
    const found = lastKeywordsIn(text);
    if (effort === undefined && found.effort !== undefined) {
      effort = found.effort;
      fromKeyword.effort = true;
    }
    if (budgetTokens === undefined && found.budgetTokens !== undefined) {
      budgetTokens = found.budgetTokens;
      fromKeyword.budget = true;
    }
  }

  const cleaned = messages.map(msg => {
    if (!msg || msg.role !== "user") return msg;
    return { ...msg, content: cleanUserContent(msg.content) };
  });

  if (effort === undefined && defaults.effort !== undefined) effort = defaults.effort;
  if (budgetTokens === undefined && defaults.budgetTokens !== undefined) budgetTokens = defaults.budgetTokens;

  return {
    effort,
    budgetTokens,
    messages: cleaned,
    matched: fromKeyword.effort || fromKeyword.budget,
    fromKeyword,
  };
}

// Thrown when an effort/thinking request violates the model's capability set.
// The chat handler turns this into a 400 with the error message so the user
// sees the actual problem instead of a generic API error.
export class EffortValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EffortValidationError";
    this.code = "EFFORT_VALIDATION";
  }
}
