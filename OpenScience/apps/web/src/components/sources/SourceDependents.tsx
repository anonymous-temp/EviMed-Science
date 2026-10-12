import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { Disclosure } from "@/components/ui/Disclosure";
import { artifactDisplayName } from "@/lib/artifactNames";
import { formatDay } from "@/lib/format";
import { getSourceDependents, memoryRecordPath, methodPath, runFilePath, type SourceDependents as Dependents } from "@/lib/knowledgeBaseClient";
import type { SourceRecord } from "@/lib/sourceClient";

const LINK = "min-w-0 truncate text-link hover:underline";

/**
 * 「相关记忆与做法」: what rests on this document — the memories written from it, the learned methods linked to the results
 * that read it, and those results — folded under the key points, and nothing at all where there is nothing (a document is
 * not told that nothing depends on it). Each line opens what it names: a memory its drawer on the memory page, a method
 * its drawer there, a result the file the conversation delivered.
 *
 * Read when the page opens (the fold needs to know whether to be drawn) and again when the document is read again. A read
 * that fails leaves the column as it was: this is an addition to the page, not a part of it.
 */
export function SourceDependents({ source }: { source: SourceRecord }) {
  const [found, setFound] = useState<Dependents | null>(null);
  const { generation } = source.payload;
  useEffect(() => {
    setFound(null);
    let active = true;
    getSourceDependents(source.id).then(
      (value) => { if (active) setFound(value); },
      () => { /* the fold is an addition; the rest of the column stands without it */ },
    );
    return () => { active = false; };
  }, [source.id, generation]);
  if (!found || found.memories.length + found.methods.length + found.results.length === 0) return null;
  return (
    <Disclosure summary="相关记忆与做法">
      <div className="space-y-4 text-ui">
        {found.memories.length > 0 && (
          <Group title="记忆">
            {found.memories.map((memory) => (
              <li key={memory.recordId} className="flex min-w-0"><Link to={memoryRecordPath(memory.recordId)} className={LINK}>{memory.text}</Link></li>
            ))}
          </Group>
        )}
        {found.methods.length > 0 && (
          <Group title="做法">
            {found.methods.map((method) => (
              <li key={method.id} className="flex min-w-0"><Link to={methodPath(method.id)} className={LINK}>{method.title}</Link></li>
            ))}
          </Group>
        )}
        {found.results.length > 0 && (
          <Group title="结果">
            {found.results.map((result) => (
              <li key={result.versionId} className="flex min-w-0 items-baseline gap-2">
                <Link to={runFilePath(result.runId, result.path)} className={LINK}>
                  {[artifactDisplayName(result.path), result.title].filter(Boolean).join(" · ")}
                </Link>
                <span className="shrink-0 text-caption text-text-3 tabular-nums">{formatDay(result.at)}</span>
              </li>
            ))}
          </Group>
        )}
      </div>
    </Disclosure>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <h2 className="text-caption text-text-3">{title}</h2>
      <ul className="space-y-1">{children}</ul>
    </div>
  );
}
