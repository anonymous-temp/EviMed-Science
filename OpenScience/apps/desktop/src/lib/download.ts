import { saveTextFile } from "./tauri";
import { toast } from "./toast";

/** Save text as a file via a Blob download. No-op outside the browser. */
export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  downloadBlob(filename, new Blob([text], { type: mime }));
}

/** Save binary data as a file via a Blob download. No-op outside the browser. */
export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Download binary data with user feedback (binary has no native "Save As" path). */
export function saveBlobWithFeedback(filename: string, blob: Blob): void {
  downloadBlob(filename, blob);
  toast.success(`已下载 ${filename}。`);
}

/**
 * Save text with user feedback: native "Save As" dialog in the desktop app
 * (toast on success/failure, silent on cancel), Blob download in the browser.
 */
export async function saveTextWithFeedback(
  filename: string,
  text: string,
  mime = "text/plain",
): Promise<void> {
  try {
    const result = await saveTextFile(filename, text);
    if (result.kind === "saved") {
      toast.success(`已保存到 ${result.path}。`);
    } else if (result.kind === "not-desktop") {
      downloadText(filename, text, mime);
      toast.success(`已下载 ${filename}。`);
    }
    // "canceled": the user closed the dialog — no feedback needed.
  } catch (err) {
    toast.error(`无法保存 ${filename}：${err instanceof Error ? err.message : String(err)}`);
  }
}
