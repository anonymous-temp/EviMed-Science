import "./ResearchObservatory.css";

export type QueueMode = "running" | "queued" | "done" | "failed" | "paused" | "waiting";
export interface QueueEntry {
  key: string;
  title: string;
  kind: "长期" | "定时";
  mode: QueueMode;
  /** 「每天 09:00」, 「最近一轮 10:42」. */
  meta: string;
}
const MODE_WORD: Record<QueueMode, string> = { running: "进行中", queued: "排队中", done: "已完成", failed: "未完成", paused: "已暂停", waiting: "待执行" };

/**
 * Anatomy: the research queue over the observatory — every research of the project as a card: its state (a dot, a
 * word), its kind and its schedule or last round. Selecting a card puts it in the observatory.
 * States: empty (a recipe with both ways to start), populated; running cards first.
 * Keyboard: each card is a button; the selected one is pressed.
 * Theme: the observatory's fixed dark ground, so queue and scene read as one console.
 */
export function ResearchQueue({ entries, selected, disabled, onSelect }: { entries: QueueEntry[]; selected: string | null; disabled?: boolean; onSelect: (key: string) => void }) {
  const running = entries.filter(entry => entry.mode === "running" || entry.mode === "queued").length;
  return <section aria-label="研究队列" className="rq">
    <div className="rq-head"><p className="obs-section-label">研究队列</p><p className="rq-count">{running > 0 ? `${running} 项进行中 · ` : ""}共 {entries.length} 项</p></div>
    {entries.length > 0 && <ul className="rq-list">{entries.map((entry, index) => <li key={entry.key}>
      <button type="button" className={`rq-card m-${entry.mode}`} aria-pressed={selected === entry.key} aria-label={entry.title} aria-describedby={`rq-${index}-s rq-${index}-m`} disabled={disabled} onClick={() => onSelect(entry.key)}>
        <span className="rq-top"><span className="rq-state" id={`rq-${index}-s`}><i aria-hidden="true" />{MODE_WORD[entry.mode]}</span><span className="rq-kind">{entry.kind}</span></span>
        <span className="rq-title">{entry.title}</span>
        <span className="rq-meta" id={`rq-${index}-m`}>{entry.meta}</span>
      </button>
    </li>)}</ul>}
  </section>;
}
