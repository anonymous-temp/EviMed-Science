import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/Button";
import { Note } from "@/components/ui/Note";
import { fetchZoneDirectory, type ZoneDirectory, type ZoneSummary } from "@/lib/evidenceTopicClient";
import { directoryZones } from "./EvidenceZoneDirectory";
import { rememberFrontierPosition } from "./frontierReadingState";
import { zonePath } from "./zoneLinks";

const MAX_ZONES = 2;
const LINK = "rounded text-link underline underline-offset-4";

/**
 * One line over the feed's results that leads to the zones the reader's words belong to (plan 2026-10-29 §4.5):
 *
 *  - a **search** whose words name a zone: 「专区：GLP-1 受体激动剂减重 ›」 (at most two); and, where it names none and the words are
 *    at least two characters, 「以此新建专区」, the way to a topic nobody has written yet;
 *  - a chosen **tag**: 「含“GLP-1 受体激动剂”的专区：…」 and the directory searched for the tag.
 *
 * It asks the platform's recommended view for the words and says nothing at all while that is read or where it fails: it is a lead, not
 * a result, and the list under it never waits for it.
 */
export function ZoneLeadLine({ kind, query, onCreate }: {
  kind: "search" | "tag";
  query: string;
  /** Opens the editor on these words (search only). */
  onCreate?: (text: string) => void;
}) {
  const [read, setRead] = useState<{ query: string; directory: ZoneDirectory } | null>(null);
  useEffect(() => {
    const words = query.trim();
    if (!words) return undefined;
    let active = true;
    fetchZoneDirectory("recommended", { q: words }).then(
      (directory) => { if (active) setRead({ query: words, directory }); },
      () => { /* a lead is not a result: without it the list stands alone */ },
    );
    return () => { active = false; };
  }, [query]);
  const words = query.trim();
  if (!read || read.query !== words) return null;
  const folded = words.toLowerCase();
  const zones: ZoneSummary[] = directoryZones(read.directory)
    .filter((zone) => kind === "tag" || zone.title.toLowerCase().includes(folded) || zone.keywords.some((entry) => entry.toLowerCase().includes(folded)))
    .slice(0, MAX_ZONES);
  const link = (zone: ZoneSummary) => (
    <Link key={zone.id} to={zonePath(zone)} onClick={rememberFrontierPosition} className={LINK}>{zone.title} ›</Link>
  );
  if (zones.length > 0) {
    return (
      <div className="mb-4">
        <Note
          action={(
            <span className="flex flex-wrap gap-x-4 gap-y-1">
              {zones.map(link)}
              {kind === "tag" && <Link to={`/app/frontier?view=zones&q=${encodeURIComponent(words)}`} className={LINK}>全部专区 ›</Link>}
            </span>
          )}
        >
          {kind === "tag" ? `含“${words}”的专区：` : "专区："}
        </Note>
      </div>
    );
  }
  if (kind === "search" && onCreate && [...words].length >= 2 && read.directory.canCreate) {
    return (
      <div className="mb-4">
        <Note action={<Button variant="text" size="sm" onClick={() => onCreate(words)}>以此新建专区</Button>}>想持续关注这个主题？</Note>
      </div>
    );
  }
  return null;
}
