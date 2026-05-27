"use server";

import { NextResponse } from "next/server";
import { getMitmAlias, setMitmAliasAll } from "@/models";
import { getMitmStatus } from "@/mitm/manager";
import { writeAliasForTool } from "@/lib/mitmAliasCache";
import {
  allowedEffortLevels,
  supportsEffort,
  supportsManualThinking,
} from "open-sse/utils/claudeEffort.js";
import {
  allowedCodexReasoningLevels,
  isCodexProviderModel,
} from "open-sse/utils/codexReasoning.js";

// GET - Get MITM aliases for a tool
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const toolName = searchParams.get("tool");
    const aliases = await getMitmAlias(toolName || undefined);
    return NextResponse.json({ aliases });
  } catch (error) {
    console.log("Error fetching MITM aliases:", error.message);
    return NextResponse.json({ error: "Failed to fetch aliases" }, { status: 500 });
  }
}

// PUT - Save MITM aliases for a specific tool
export async function PUT(request) {
  try {
    const { tool, mappings } = await request.json();

    if (!tool || !mappings || typeof mappings !== "object") {
      return NextResponse.json({ error: "tool and mappings required" }, { status: 400 });
    }

    // Check if DNS is enabled for this tool
    const status = await getMitmStatus();
    if (!status.dnsStatus || !status.dnsStatus[tool]) {
      return NextResponse.json(
        { error: `DNS must be enabled for ${tool} before editing model mappings` },
        { status: 403 }
      );
    }

    // Mapping values are either:
    //   - a plain string ("provider/modelId") — legacy form for non-antigravity tools
    //   - an object { model, effort?, thinkingBudget? } — used for antigravity per-alias config
    //
    // Effort/budget extras are validated against the model's published capability
    // matrix (see open-sse/utils/claudeEffort.js). Saves that pair an invalid
    // level with a model are rejected so the dashboard never persists garbage.
    const filtered = {};
    const errors = [];
    for (const [alias, value] of Object.entries(mappings)) {
      if (!value) continue;
      if (typeof value === "string") {
        if (value.trim()) filtered[alias] = value.trim();
        continue;
      }
      if (typeof value === "object") {
        const modelStr = typeof value.model === "string" ? value.model.trim() : "";
        if (!modelStr) continue;
        const entry = { model: modelStr };
        const rawEffort = value.effort ? String(value.effort).toLowerCase() : "";
        if (rawEffort) {
          if (!supportsEffort(modelStr)) {
            errors.push(`${alias}: model ${modelStr} does not support the effort parameter`);
          } else if (!allowedEffortLevels(modelStr).has(rawEffort)) {
            const allowed = [...allowedEffortLevels(modelStr)].join(", ");
            errors.push(`${alias}: effort "${rawEffort}" not valid for ${modelStr} (allowed: ${allowed})`);
          } else {
            entry.effort = rawEffort;
          }
        }
        const budget = Number(value.thinkingBudget);
        if (Number.isFinite(budget) && budget > 0) {
          if (budget > 128000) {
            errors.push(`${alias}: thinkingBudget ${budget} exceeds the 128000 cap`);
          } else if (!supportsManualThinking(modelStr)) {
            errors.push(`${alias}: model ${modelStr} does not support manual thinking budget`);
          } else {
            entry.thinkingBudget = Math.floor(budget);
          }
        }
        const rawReasoning = value.reasoning ? String(value.reasoning).toLowerCase() : "";
        if (rawReasoning) {
          if (!isCodexProviderModel(modelStr)) {
            errors.push(`${alias}: reasoning only applies to Codex provider models`);
          } else if (!allowedCodexReasoningLevels.includes(rawReasoning)) {
            const allowed = allowedCodexReasoningLevels.join(", ");
            errors.push(`${alias}: reasoning "${rawReasoning}" not valid for ${modelStr} (allowed: ${allowed})`);
          } else {
            entry.reasoning = rawReasoning;
          }
        }
        // Collapse to bare string when no extras are set — keeps the data file
        // identical to the legacy format and avoids object churn in diffs.
        filtered[alias] = entry.effort || entry.thinkingBudget || entry.reasoning ? entry : modelStr;
      }
    }

    if (errors.length > 0) {
      return NextResponse.json({ error: errors.join("; ") }, { status: 400 });
    }

    await setMitmAliasAll(tool, filtered);
    writeAliasForTool(tool, filtered);
    return NextResponse.json({ success: true, aliases: filtered });
  } catch (error) {
    console.log("Error saving MITM aliases:", error.message);
    return NextResponse.json({ error: "Failed to save aliases" }, { status: 500 });
  }
}
