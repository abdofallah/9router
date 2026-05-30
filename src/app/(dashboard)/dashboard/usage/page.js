"use client";

import { Suspense, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { UsageStats, RequestLogger, CardSkeleton, SegmentedControl } from "@/shared/components";
import RequestDetailsTab from "./components/RequestDetailsTab";

const PERIODS = [
  { value: "today", label: "Today" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7D" },
  { value: "30d", label: "30D" },
  { value: "60d", label: "60D" },
];

function formatDateInput(date) {
  return date.toISOString().slice(0, 10);
}

export default function UsagePage() {
  return (
    <Suspense fallback={<CardSkeleton />}>
      <UsageContent />
    </Suspense>
  );
}

function UsageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [period, setPeriod] = useState("today");
  const [draftRange, setDraftRange] = useState(() => ({
    startDate: formatDateInput(new Date()),
    endDate: formatDateInput(new Date()),
  }));
  const [customRange, setCustomRange] = useState(null);

  const tabFromUrl = searchParams.get("tab");
  const activeTab = tabFromUrl && ["overview", "logs", "details"].includes(tabFromUrl)
    ? tabFromUrl
    : "overview";

  const usageRange = useMemo(() => {
    if (customRange?.startDate && customRange?.endDate) {
      return { mode: "custom", ...customRange };
    }
    return { mode: "preset", period };
  }, [customRange, period]);

  const isRangeInvalid = Boolean(
    draftRange.startDate && draftRange.endDate && draftRange.startDate > draftRange.endDate
  );
  const canApplyRange = Boolean(draftRange.startDate && draftRange.endDate && !isRangeInvalid);

  const handleTabChange = (value) => {
    if (value === activeTab) return;
    const params = new URLSearchParams(searchParams);
    params.set("tab", value);
    router.push(`/dashboard/usage?${params.toString()}`, { scroll: false });
  };

  const handlePresetChange = (value) => {
    setCustomRange(null);
    setPeriod(value);
  };

  const handleApplyRange = () => {
    if (!canApplyRange) return;
    setCustomRange({ ...draftRange });
  };

  const handleClearRange = () => {
    setCustomRange(null);
  };

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Tabs + period selector on same row */}
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <SegmentedControl
          options={[
            { value: "overview", label: "Overview" },
            { value: "details", label: "Details" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
          className="w-full sm:w-auto"
        />
        {activeTab === "overview" && (
          <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-end">
            <SegmentedControl
              options={PERIODS}
              value={period}
              onChange={handlePresetChange}
              size="sm"
              className="w-full sm:w-auto"
            />
            <div className="rounded-xl border border-border bg-surface/80 p-2 shadow-sm backdrop-blur sm:p-2.5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted" htmlFor="usage-custom-start-date">
                    From
                    <input
                      id="usage-custom-start-date"
                      type="date"
                      value={draftRange.startDate}
                      onChange={(e) => setDraftRange((prev) => ({ ...prev, startDate: e.target.value }))}
                      className="h-9 rounded-lg border border-border bg-bg px-2 text-sm font-medium normal-case tracking-normal text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </label>
                  <label className="flex flex-col gap-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted" htmlFor="usage-custom-end-date">
                    To
                    <input
                      id="usage-custom-end-date"
                      type="date"
                      value={draftRange.endDate}
                      onChange={(e) => setDraftRange((prev) => ({ ...prev, endDate: e.target.value }))}
                      className="h-9 rounded-lg border border-border bg-bg px-2 text-sm font-medium normal-case tracking-normal text-text-main focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                  </label>
                </div>
                <div className="flex items-center gap-2 sm:self-end">
                  <button
                    id="usage-apply-custom-range"
                    type="button"
                    onClick={handleApplyRange}
                    disabled={!canApplyRange}
                    className="h-9 rounded-lg bg-primary px-3 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Apply
                  </button>
                  <button
                    id="usage-clear-custom-range"
                    type="button"
                    onClick={handleClearRange}
                    disabled={!customRange}
                    className="h-9 rounded-lg border border-border px-3 text-sm font-semibold text-text-muted transition hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Presets
                  </button>
                </div>
              </div>
              {isRangeInvalid && (
                <p className="mt-2 text-xs font-medium text-error">Start date must be before or equal to end date.</p>
              )}
              {customRange && !isRangeInvalid && (
                <p className="mt-2 text-xs text-text-muted">
                  Showing custom usage from <span className="font-semibold text-text-main">{customRange.startDate}</span> to <span className="font-semibold text-text-main">{customRange.endDate}</span>.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {activeTab === "overview" && (
        <Suspense fallback={<CardSkeleton />}>
          <UsageStats period={period} setPeriod={setPeriod} range={usageRange} hidePeriodSelector />
        </Suspense>
      )}
      {activeTab === "logs" && <RequestLogger />}
      {activeTab === "details" && <RequestDetailsTab />}
    </div>
  );
}
