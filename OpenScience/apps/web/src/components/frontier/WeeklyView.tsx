import { useEffect, useState } from "react";
import { fetchFrontierWeekly, listFrontierWeeklies, frontierErrorMessage } from "@/lib/frontierClient";
import { DailyIssue, type DailyState } from "./DailyView";

/** Rows of each lane the weekly shows before 「展开其余 N 条」: a week holds ten times a day's items. */
const WEEKLY_LANE_ROWS = 5;

/**
 * The weekly's archive and the week asked for (`?week=`) or the newest, read together. The page owns the read (as it does the
 * daily's), because the issue's controls — 分类, 往期, 复制 — are in the page's toolbar and need the same state the issue is drawn from.
 */
export function useFrontierWeekly(week: string | null, enabled: boolean): DailyState {
  const [state, setState] = useState<Omit<DailyState, "retry">>({ index: null, issue: null, loading: enabled, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    setState({ index: null, issue: null, loading: true, error: null });
    (async () => {
      const index = await listFrontierWeeklies();
      const selected = week ?? index?.[0]?.weekStart;
      const issue = selected && index !== null ? await fetchFrontierWeekly(selected) : null;
      return { index: index?.map((entry) => ({ ...entry, day: entry.weekStart })) ?? null, issue, loading: false, error: null };
    })().then((next) => { if (active) setState(next); }, (error: unknown) => {
      if (active) setState({ index: null, issue: null, loading: false, error: frontierErrorMessage(error) });
    });
    return () => { active = false; };
  }, [week, attempt, enabled]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/** The week on screen: the issue, five rows of each lane. */
export function WeeklyView({ state, onWeek }: { state: DailyState; onWeek: (week: string) => void }) {
  return <DailyIssue weekly laneLimit={WEEKLY_LANE_ROWS} state={state} onDay={onWeek} />;
}
