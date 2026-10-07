import { Button } from "@/components/ui/Button";
import { WebApiError } from "@/lib/apiClient";

/** The record a drawer was asked to open does not exist: removed since a link to it was made, or never there. */
export class RecordMissing extends Error {
  constructor() { super("record missing"); }
}

/**
 * A read of the record itself, whose 404 means the record is gone. Only the record's own reads go through it: a 404 from a
 * read about something else (the project, say) is not a missing record. For a non-owner's record the server answers the same
 * 404 as for a missing one, so those two are one state by design.
 */
export function orMissing<T>(read: Promise<T>): Promise<T> {
  return read.catch((caught: unknown) => { throw caught instanceof WebApiError && caught.status === 404 ? new RecordMissing() : caught; });
}

/**
 * What a drawer shows for a record that is not there: one sentence and the way back to the list. Not an error line — there
 * is nothing to retry, and 刷新 would repeat a read that cannot succeed.
 */
export function MissingRecord({ noun, list, onBack }: { noun: "插件" | "技能"; list: string; onBack: () => void }) {
  return (
    <div role="status" className="flex flex-col items-start gap-4">
      <p className="text-ui text-text-2">{`找不到这个${noun}，它可能已被移除。`}</p>
      <Button variant="secondary" onClick={onBack}>{list}</Button>
    </div>
  );
}
