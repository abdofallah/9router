import { NextResponse } from "next/server";
import { getChartData } from "@/lib/usageDb";

const VALID_PERIODS = new Set(["today", "24h", "7d", "30d", "60d", "custom"]);
const MAX_CUSTOM_RANGE_DAYS = 366;

function parseDateOnly(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return null;
  const date = new Date(`${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getCustomRange(searchParams) {
  const startDate = searchParams.get("startDate");
  const endDate = searchParams.get("endDate");
  const start = parseDateOnly(startDate);
  const end = parseDateOnly(endDate, true);

  if (!start || !end) return { error: "Custom range requires valid startDate and endDate in YYYY-MM-DD format" };
  if (start > end) return { error: "startDate must be before or equal to endDate" };
  if ((end.getTime() - start.getTime()) / 86400000 > MAX_CUSTOM_RANGE_DAYS) {
    return { error: `Custom range cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days` };
  }
  return { range: { period: "custom", startDate, endDate } };
}

export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const period = searchParams.get("period") || "7d";

    if (!VALID_PERIODS.has(period)) {
      return NextResponse.json({ error: "Invalid period" }, { status: 400 });
    }

    if (period === "custom") {
      const { range, error } = getCustomRange(searchParams);
      if (error) return NextResponse.json({ error }, { status: 400 });
      const data = await getChartData(range);
      return NextResponse.json(data);
    }

    const data = await getChartData(period);
    return NextResponse.json(data);
  } catch (error) {
    console.error("[API] Failed to get chart data:", error);
    return NextResponse.json({ error: "Failed to fetch chart data" }, { status: 500 });
  }
}
