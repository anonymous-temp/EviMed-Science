import { useEffect, useRef, useState } from "react";
import { Drawer } from "@/components/ui/Drawer";
import { Button } from "@/components/ui/Button";
import { InlineAlert } from "@/components/ui/InlineAlert";
import { webErrorMessage } from "@/lib/apiClient";
import { getVcrProtectedDocument } from "@/lib/vcrClient";

/** A sentence of a patient's record: which document, and where in it. */
export interface VcrRecordSpot { documentId: string; start: number; end: number }

/** Characters of the record shown on each side of the sentence before the reader asks for the whole. */
const AROUND = 1_200;

type Loaded = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; text: string };

/**
 * 「查看病历」: a patient's record opened at the sentence a judgment rests on, the sentence marked and its neighbours around it.
 *
 * Hidden knowledge:
 *  - **The record is read under the reader's own grant** (`read_patient_level`), the same route the data tab's document reader uses; a
 *    reader who may not read it is told so, and the sentence in the clause table stays where it was.
 *  - **The offsets are the original's.** A sentence is shown in the table only when the record still says it at those offsets, so
 *    the mark falls on the sentence; if the text has since changed, the whole record is shown unmarked and no sentence is claimed.
 *  - A long record opens at the sentence, not at its head, and the rest is one press away.
 */
export function VcrRecordDrawer({ studyId, spot, onClose }: { studyId: string; spot: VcrRecordSpot; onClose: () => void }) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const [whole, setWhole] = useState(false);
  const [round, setRound] = useState(0);
  const mark = useRef<HTMLElement>(null);

  useEffect(() => {
    let current = true;
    setLoaded({ kind: "loading" });
    getVcrProtectedDocument(studyId, spot.documentId)
      .then((answer) => { if (current) setLoaded({ kind: "ready", text: answer.document.text }); })
      .catch((error: unknown) => { if (current) setLoaded({ kind: "error", message: webErrorMessage(error, { fallback: "病历暂时无法打开，请稍后重试。" }) }); });
    return () => { current = false; };
  }, [studyId, spot.documentId, round]);

  useEffect(() => {
    if (loaded.kind === "ready") mark.current?.scrollIntoView?.({ block: "center" });
  }, [loaded, whole]);

  return (
    <Drawer title="病历原文" onClose={onClose} widthClassName="max-w-2xl">
      {loaded.kind === "loading" && <p role="status" className="py-6 text-ui text-text-2">正在打开病历</p>}
      {loaded.kind === "error" && <InlineAlert onRetry={() => setRound((value) => value + 1)}>{loaded.message}</InlineAlert>}
      {loaded.kind === "ready" && <Record text={loaded.text} spot={spot} whole={whole} mark={mark} onWhole={() => setWhole(true)} />}
    </Drawer>
  );
}

function Record({ text, spot, whole, mark, onWhole }: { text: string; spot: VcrRecordSpot; whole: boolean; mark: React.RefObject<HTMLElement | null>; onWhole: () => void }) {
  const found = spot.start >= 0 && spot.end > spot.start && spot.end <= text.length;
  if (!found) return <p data-vcr-record="" className="whitespace-pre-wrap text-ui text-text">{text}</p>;
  const from = whole ? 0 : Math.max(0, spot.start - AROUND);
  const to = whole ? text.length : Math.min(text.length, spot.end + AROUND);
  return (
    <div data-vcr-record="" className="flex flex-col gap-3">
      {from > 0 && <Button variant="text" size="sm" onClick={onWhole}>从头显示</Button>}
      <p className="whitespace-pre-wrap text-ui text-text">
        {text.slice(from, spot.start)}
        <mark ref={mark} data-vcr-record-sentence="" className="rounded bg-highlight px-0.5 text-text">{text.slice(spot.start, spot.end)}</mark>
        {text.slice(spot.end, to)}
      </p>
      {to < text.length && <Button variant="text" size="sm" onClick={onWhole}>显示到结尾</Button>}
    </div>
  );
}
