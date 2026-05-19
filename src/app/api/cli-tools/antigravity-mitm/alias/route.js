"use server";

import { NextResponse } from "next/server";
import { getMitmAlias, setMitmAliasAll } from "@/models";
import { getMitmStatus } from "@/mitm/manager";
import { writeAliasForTool } from "@/lib/mitmAliasCache";

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
    const ALLOWED_EFFORT = new Set(["low", "medium", "high", "xhigh", "max"]);
    const filtered = {};
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
        if (value.effort && ALLOWED_EFFORT.has(String(value.effort).toLowerCase())) {
          entry.effort = String(value.effort).toLowerCase();
        }
        const budget = Number(value.thinkingBudget);
        if (Number.isFinite(budget) && budget > 0 && budget <= 128000) {
          entry.thinkingBudget = Math.floor(budget);
        }
        // Collapse to bare string when no extras are set — keeps the data file
        // identical to the legacy format and avoids object churn in diffs.
        filtered[alias] = entry.effort || entry.thinkingBudget ? entry : modelStr;
      }
    }

    await setMitmAliasAll(tool, filtered);
    writeAliasForTool(tool, filtered);
    return NextResponse.json({ success: true, aliases: filtered });
  } catch (error) {
    console.log("Error saving MITM aliases:", error.message);
    return NextResponse.json({ error: "Failed to save aliases" }, { status: 500 });
  }
}
