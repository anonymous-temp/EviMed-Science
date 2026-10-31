import { useRef, useState } from "react";
import { webErrorMessage } from "@/lib/apiClient";
import { offerMemoryImport, saveMemoryImport, type MemoryImportOffer } from "@/lib/memoryClient";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/Button";
import { FormDialog } from "@/components/ui/FormDialog";
import { Textarea } from "@/components/ui/Input";

/** The most the control plane reads of a pasted text (`IMPORT_MAX_CHARS`). */
export const IMPORT_MAX_CHARS = 8_000;

/**
 * What the person sends to the assistant they used before. It asks for lines about the person and nothing else, and it says what is not
 * wanted: nothing about other people, and none of the secrets the platform never keeps.
 */
export const IMPORT_PROMPT = [
  "请列出你记得的关于我本人的全部信息，每条一行，只写我自己的：",
  "我的身份和工作、我做事的偏好和习惯、我常用的工具、我正在做的项目。",
  "不要写别人的信息，不要写密码、证件号、银行卡这类内容，不要加解释，也不要加标题。",
].join("\n");

/** The plain text an old archive is kept in: a file is read here in the browser, so anything else would arrive as noise. */
export const IMPORT_FILE_TYPES = ".md,.markdown,.txt,.text,.log,.rst,.org";

function readBytes(blob: Blob): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error("unreadable"));
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * The start of a file as text: no more of it than an import can hold, so a huge log does not stop the tab, and in UTF-8 or, where that is not what it is, in the GB encodings an old
 * Windows file is in, so it never fills the box with replacement characters. A UTF-8 file cut inside a character is not a reason to call it something else, so a cut read tolerates its last bytes.
 */
export async function readFileText(file: Blob): Promise<{ text: string; cut: boolean }> {
  const most = IMPORT_MAX_CHARS * 4;
  const cut = file.size > most;
  const bytes = await readBytes(file.slice(0, most));
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes, { stream: cut }), cut };
  } catch {
    return { text: new TextDecoder("gb18030").decode(bytes), cut };
  }
}

/** Several texts as one, a blank line between them, within what the control plane reads; `cut` says something did not fit. */
export function joinImportFiles(texts: readonly string[]): { text: string; cut: boolean } {
  const whole = texts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  return { text: whole.slice(0, IMPORT_MAX_CHARS), cut: whole.length > IMPORT_MAX_CHARS };
}

type Step = "prompt" | "paste" | "review";

/**
 * 「从其他 AI 导入」: four short steps in one dialog. Copy the question to the assistant used before; paste what it answered; read what
 * this one made of it (short statements in the person's voice, each one tickable); save the ones to keep. What is private (health, money, a
 * child) is offered unticked and says so; what is never kept (a password, an identity number, someone else's details) is not offered, and one
 * plain line says that some lines were left out for that reason. Nothing is written until 保存.
 *
 * The statements are the person's own once they save: the engine writes them under its own rules, which apply a second time.
 */
export function ImportDialog({ onClose, onSaved }: {
  onClose: () => void;
  /** The statements were handed to the memory: the page reads its list again, and they appear when the engine has written them. */
  onSaved: () => void;
}) {
  const [step, setStep] = useState<Step>("prompt");
  const [text, setText] = useState("");
  const [offer, setOffer] = useState<MemoryImportOffer | null>(null);
  const [kept, setKept] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  const picker = useRef<HTMLInputElement>(null);

  /** What the files say, one after another, into the same box a paste goes into: the person reads it there before anything is read out of it. */
  const takeFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setError(null);
    try {
      const read = await Promise.all([...files].map(readFileText));
      const { text: next, cut: over } = joinImportFiles([text, ...read.map((file) => file.text)]);
      setText(next);
      setCut(over || read.some((file) => file.cut));
    } catch {
      setError("没有读出这份文件，请确认它是纯文本。");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(IMPORT_PROMPT);
      toast.success("已复制");
    } catch {
      toast.error("无法复制，请手动选择文字复制");
    }
  };
  const read = async () => {
    const pasted = text.trim();
    if (!pasted || busy) return;
    setBusy(true);
    setError(null);
    try {
      const next = await offerMemoryImport(pasted);
      setOffer(next);
      setKept(new Set(next.statements.filter((statement) => statement.ticked).map((statement) => statement.id)));
      setStep("review");
    } catch (reason) {
      setError(webErrorMessage(reason, { fallback: "没有读出内容，请重试。" }));
    } finally {
      setBusy(false);
    }
  };
  const save = async (markSaved: () => void) => {
    if (!offer || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveMemoryImport(offer.id, [...kept]);
      toast.success(saved.saved > 0 ? `已交给记忆：${saved.saved} 条，几秒后出现在列表里` : "没有选中的内容，没有记下");
      markSaved(); setText(""); setBusy(false);
      onSaved();
      onClose();
    } catch (reason) {
      setError(webErrorMessage(reason, { fallback: "没有记下，请重试。" }));
      setBusy(false);
    }
  };
  const toggle = (id: string, on: boolean) => setKept((current) => { const next = new Set(current); if (on) next.add(id); else next.delete(id); return next; });

  return (
    <FormDialog title="从其他 AI 导入" onClose={onClose} busy={busy} dirty={text.length > 0}>
      {(_requestClose, markSaved) => <>
      {step === "prompt" && (
        <div className="space-y-3">
          <p className="text-ui text-text">把下面这段话发给你原来用的 AI 助手，请它把记得的关于你的内容列出来。</p>
          <pre aria-label="要发给原来助手的话" className="max-w-measure whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 text-ui text-text">{IMPORT_PROMPT}</pre>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => void copy()}>复制这段话</Button>
            <Button type="button" onClick={() => setStep("paste")}>下一步</Button>
          </div>
        </div>
      )}
      {step === "paste" && (
        <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void read(); }}>
          <p className="text-ui text-text">把它的回答粘贴在这里，或者选一份以前写好的档案，最多 {IMPORT_MAX_CHARS.toLocaleString("zh-CN")} 个字。</p>
          <Textarea aria-label="原来助手的回答" rows={8} maxLength={IMPORT_MAX_CHARS} value={text} onChange={(event) => { setText(event.target.value); setCut(false); }} />
          {cut && <p role="status" className="text-ui text-text">文件比 {IMPORT_MAX_CHARS.toLocaleString("zh-CN")} 个字长，只读入了前面的部分。可以分几次导入。</p>}
          {error && <p role="alert" className="text-ui text-error">{error}</p>}
          <input ref={picker} type="file" multiple accept={IMPORT_FILE_TYPES} aria-label="选择档案文件" className="sr-only" tabIndex={-1} onChange={(event) => { void takeFiles(event.target.files); event.target.value = ""; }} />
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-3 text-caption text-text-3">
              <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => picker.current?.click()}>选择文件</Button>
              {text.length} / {IMPORT_MAX_CHARS}
            </span>
            <div className="flex gap-2">
              <Button type="button" variant="text" disabled={busy} onClick={() => setStep("prompt")}>上一步</Button>
              <Button type="submit" loading={busy} disabled={!text.trim()}>读取</Button>
            </div>
          </div>
        </form>
      )}
      {step === "review" && offer && (
        <div className="space-y-3">
          {offer.statements.length > 0
            ? <p className="text-ui text-text">下面是读出的内容。勾选的会记下，不勾的不会。</p>
            : <p className="text-ui text-text">没有读出可以记下的内容。</p>}
          <ul className="max-h-96 space-y-2 overflow-y-auto">
            {offer.statements.map((statement) => (
              <li key={statement.id}>
                <label className="flex items-start gap-2 text-ui">
                  <input type="checkbox" className="mt-1" checked={kept.has(statement.id)} disabled={busy} onChange={(event) => toggle(statement.id, event.target.checked)} />
                  <span className="min-w-0 max-w-measure whitespace-pre-wrap text-text">{statement.text}</span>
                </label>
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="text-ui text-error">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="text" disabled={busy} onClick={() => setStep("paste")}>返回修改</Button>
            <Button type="button" loading={busy} disabled={kept.size === 0} onClick={() => void save(markSaved)}>保存所选</Button>
          </div>
        </div>
      )}
      </>}
    </FormDialog>
  );
}
