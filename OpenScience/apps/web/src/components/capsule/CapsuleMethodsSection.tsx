import { useState, type FormEvent, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { announceMemoryChanged, ensureMyCapsule, fetchMyCapsule } from "@/lib/memoryClient";
import { addCapsuleEntry, productErrorMessage } from "@/lib/productClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { Textarea } from "@/components/ui/Input";
import { CapsuleEntryRow } from "./CapsuleEntryRow";
import { SectionList, SectionShell } from "./SectionShell";
import { useCapsuleData } from "./useCapsuleData";

/** The capsule entry kinds that are ways of working rather than facts. */
const METHOD_KINDS = new Set(["method_preference"]);

/**
 * 「方法」: one list of how the researcher works, whatever its source —
 * written in their capsule, learned from their tasks, or borrowed from
 * someone else's (proposal §4.2). Sharing sits here too, because what a
 * person shares is how they work.
 *
 * The learned methods, the received shelf and the sharing panel are passed in:
 * each is its own page-level component with its own reads.
 */
export function CapsuleMethodsSection({
  learned,
  received,
  share,
  manage,
}: {
  learned: ReactNode;
  received: ReactNode;
  share: ReactNode;
  /** Every capsule, one by one — folded away, because a person has one. */
  manage: ReactNode;
}) {
  const { data, failed, reload } = useCapsuleData(fetchMyCapsule);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const mine = (data?.entries ?? []).filter((entry) => METHOD_KINDS.has(entry.payload.factKind));

  const add = async (event: FormEvent) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setSaving(true);
    try {
      const capsule = data?.capsule ?? await ensureMyCapsule();
      await addCapsuleEntry(capsule.id, { factKind: "method_preference", layer: "methods", content });
      setDraft("");
      toast.success("已记下这个方法，之后的任务会用到它");
      announceMemoryChanged();
      reload();
    } catch (error) {
      toast.error(`没有记下：${productErrorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionShell
      intro="你怎么做研究：你写下的方法立即生效；从任务中学到的方法经过和现有做法的配对评测才生效；别人分享给你的胶囊整包启用、随时停用。"
      loading={data === null}
      failed={failed}
      onRetry={reload}
    >
      <SectionList title="你写下的方法" count={mine.length} empty="还没有写下方法。写一条你常用的做法，之后的任务会照着做。">
        {mine.map((entry) => <CapsuleEntryRow key={entry.id} entry={entry} onChanged={reload} />)}
      </SectionList>
      <form onSubmit={(event) => void add(event)} className="rounded-card border border-border bg-surface p-4">
        <Textarea
          label="写一个方法"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          rows={3}
          maxLength={20000}
          placeholder="例如：做 meta 分析先查异质性，I² 超过 50% 时说明原因再合并。"
        />
        <div className="mt-3 flex justify-end">
          <Button type="submit" loading={saving} disabled={!draft.trim()}>
            {!saving && <Plus size={14} aria-hidden="true" />}记下
          </Button>
        </div>
      </form>
      <section aria-label="从任务中学到的方法">
        <h3 className="text-body font-semibold text-text">从任务中学到的方法</h3>
        <div className="mt-2">{learned}</div>
      </section>
      <section aria-label="收到的胶囊">
        <h3 className="text-body font-semibold text-text">收到的胶囊</h3>
        <div className="mt-2">{received}</div>
      </section>
      <section aria-label="分享">
        <h3 className="text-body font-semibold text-text">分享</h3>
        <div className="mt-2">{share}</div>
      </section>
      <Disclosure summary="逐个管理胶囊（一般不需要）">{manage}</Disclosure>
    </SectionShell>
  );
}
