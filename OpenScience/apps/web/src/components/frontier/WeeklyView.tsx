import { useEffect, useState } from "react";
import { fetchFrontierWeekly, listFrontierWeeklies, frontierErrorMessage } from "@/lib/frontierClient";
import { DailyIssue, type DailyState } from "./DailyView";

export function WeeklyView({ week, onWeek }: { week: string | null; onWeek: (week: string) => void }) {
  const [state, setState] = useState<Omit<DailyState, "retry">>({ index: null, issue: null, loading: true, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
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
  }, [week, attempt]);
  return <DailyIssue weekly state={{ ...state, retry: () => setAttempt((n) => n + 1) }} onDay={onWeek} />;
}
