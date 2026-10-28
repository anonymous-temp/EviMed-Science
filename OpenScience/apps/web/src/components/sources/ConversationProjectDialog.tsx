import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Combobox, type ComboboxOption } from "@/components/ui/Combobox";
import { FormDialog } from "@/components/ui/FormDialog";

/**
 * 「选择对话项目」: asked only when documents can be used in more than one project's conversation — one that takes effect in several
 * projects, or in all of them. A document that takes effect in exactly one project opens that project's conversation without asking, and
 * nothing here moves the sidebar: the project is chosen for this conversation alone, by the person, from the projects that can read what
 * they picked.
 */
export function ConversationProjectDialog({ options, onClose, onChoose }: {
  options: readonly ComboboxOption[];
  onClose: () => void;
  onChoose: (projectId: string) => void;
}) {
  const [target, setTarget] = useState<string | null>(null);
  return (
    <FormDialog title="选择对话项目" onClose={onClose}>
      {(requestClose) => (
        <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); if (target) onChoose(target); }}>
          <Combobox label="项目" hint="在这个项目的对话里使用所选资料。" value={target} onChange={setTarget} options={options} clearable={false} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={requestClose}>取消</Button>
            <Button type="submit" disabled={!target}>在对话中使用</Button>
          </div>
        </form>
      )}
    </FormDialog>
  );
}
