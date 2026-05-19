// Claude effort & thinking helpers — mirrors Claude Code v2.1.92 behavior.
//
// Two independent dimensions:
//   - effort: 'low' | 'medium' | 'high' | 'max'  → output_config.effort
//   - thinking: { type: 'adaptive' } (modern models) | { type: 'enabled', budget_tokens } (older)
//
// Plus a 9router-specific UX shortcut: users can override per-message via
//   [effortlevel:high]      → bumps output_config.effort
//   [thinkingbudget:8192]   → forces budget-based thinking with the given tokens

// Per the Claude effort spec (platform.claude.com/docs/en/build-with-claude/effort):
//   low, medium, high — all effort-supporting models (default: high)
//   max               — Mythos Preview, Opus 4.7, Opus 4.6, Sonnet 4.6
//   xhigh             — Opus 4.7 ONLY (extended capability for long-horizon work)
// `xhigh` is a real distinct level (between high and max in intensity),
// not an alias for max.
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Fallback effort→budget mapping for older models that lack output_config.effort
// support (pre-4.6 Claudes). Modern models go through adaptive thinking +
// output_config.effort instead, so these numbers are only used as a legacy
// reasoning_effort shim. xhigh is intentionally omitted — it's Opus 4.7-only
// and would never reach this branch (the support check rejects it first).
export const EFFORT_TO_BUDGET = {
  low: 4096,
  medium: 8192,
  high: 16384,
  max: 32768,
};

// Heuristic: opus-4-6 / sonnet-4-6 and anything newer (claude-4-7+) use adaptive
// thinking. The match is loose to tolerate vendor prefixes like "cc/" or full
// IDs like "claude-opus-4-6-20251001".
export function isAdaptiveThinkingModel(model) {
  if (!model || typeof model !== "string") return false;
  const m = model.toLowerCase();
  // Modern Claude 4.6+ adaptive-capable models
  return /(?:opus|sonnet|haiku)-4-(?:6|7|8|9)\b/.test(m)
      || /claude-(?:opus|sonnet|haiku)-4-(?:6|7|8|9)/.test(m);
}

// `max` effort: Mythos Preview, Opus 4.7, Opus 4.6, Sonnet 4.6. Haiku and older
// Claudes don't accept it. Per user policy we error rather than silently clamp.
export function supportsMaxEffort(model) {
  if (!model || typeof model !== "string") return false;
  const m = model.toLowerCase();
  // opus-4-6/4-7/4-8/4-9, sonnet-4-6/4-7+, plus future mythos-* preview lineage.
  return /opus-4-(?:6|7|8|9)\b/.test(m)
      || /sonnet-4-(?:6|7|8|9)\b/.test(m)
      || /mythos/.test(m);
}

// `xhigh` effort: Opus 4.7 only (and forward — 4.8/4.9 reserved).
export function supportsXHighEffort(model) {
  if (!model || typeof model !== "string") return false;
  return /opus-4-(?:7|8|9)\b/.test(model.toLowerCase());
}

// Two-tier regexes — strict for capturing valid values, permissive for stripping.
//
// The strict regex enforces the canonical level vocabulary (low/medium/high/
// xhigh/max — per the official Claude effort spec). The permissive strip regex
// catches ANY `[effortlevel:foo]` or `[thinkingbudget:bar]` token, so typos
// or unrecognized values are still removed from user prompts rather than
// being surfaced to the model verbatim.
const EFFORT_RE        = /\[effortlevel:(low|medium|high|xhigh|max)\]/gi;
const BUDGET_RE        = /\[thinkingbudget:(\d{2,7})\]/gi;
const EFFORT_STRIP_RE  = /\[effortlevel:[^\]\n]*\]/gi;
const BUDGET_STRIP_RE  = /\[thinkingbudget:[^\]\n]*\]/gi;

// Strip all keyword occurrences from a string. Also collapses the surrounding
// whitespace so we don't leave "Hello   world" if the keyword was sandwiched.
// Uses the permissive strip regexes so unrecognized values are also removed.
function stripKeywords(text) {
  if (!text) return text;
  return text
    .replace(EFFORT_STRIP_RE, "")
    .replace(BUDGET_STRIP_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")     // drop trailing-of-line whitespace
    .replace(/\n[ \t]+\n/g, "\n\n")
    .trim();
}

// Find the LAST effort + budget keyword in a single text chunk.
// Returns { effort?, budgetTokens? } — undefined when the keyword wasn't present.
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

// Walk a single user message's content (string or array of blocks) and apply
// stripKeywords to every text piece. Returns the cleaned content in the same
// shape as the input.
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

// Extract the text portion of a message for keyword scanning. We only scan
// user-role messages — assistant text is the model's own output and would
// never legitimately carry a `[effortlevel:…]` instruction from the user.
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

/**
 * Scan messages newest→oldest for effort/budget keywords and return the
 * latest match. Always strips keywords from EVERY user message regardless of
 * which one provided the winning value (so the API never sees the literal
 * `[effortlevel:…]` markers).
 *
 * @param {Array} messages - OpenAI-format messages array
 * @param {object} [defaults] - { effort?, budgetTokens? } fallback if no keyword found
 * @returns {{ effort?: string, budgetTokens?: number, messages: Array, matched: boolean }}
 */
export function parseEffortKeywords(messages, defaults = {}) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ...defaults, messages: messages || [], matched: false };
  }

  let effort;
  let budgetTokens;
  let matched = false;

  // Walk newest→oldest, first hit wins. Each dimension (effort vs budget) is
  // resolved independently so a user can set effort in turn 5 and budget in
  // turn 3 — both stick until overridden.
  for (let i = messages.length - 1; i >= 0; i--) {
    if (effort !== undefined && budgetTokens !== undefined) break;
    const text = userTextOf(messages[i]);
    if (!text) continue;
    const found = lastKeywordsIn(text);
    if (effort === undefined && found.effort !== undefined) {
      effort = found.effort;
      matched = true;
    }
    if (budgetTokens === undefined && found.budgetTokens !== undefined) {
      budgetTokens = found.budgetTokens;
      matched = true;
    }
  }

  // Strip keywords from every user message — the API never sees them.
  const cleaned = messages.map(msg => {
    if (!msg || msg.role !== "user") return msg;
    return { ...msg, content: cleanUserContent(msg.content) };
  });

  // Fallback to defaults for whichever dimension the user didn't override.
  if (effort === undefined && defaults.effort !== undefined) effort = defaults.effort;
  if (budgetTokens === undefined && defaults.budgetTokens !== undefined) budgetTokens = defaults.budgetTokens;

  return { effort, budgetTokens, messages: cleaned, matched };
}

// Thrown when a user requests `[effortlevel:max]` for a model that doesn't
// support it. The router catches this and surfaces it as a stream-side error
// instead of forwarding to the API.
export class EffortValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "EffortValidationError";
    this.code = "EFFORT_VALIDATION";
  }
}
