/** Composition keys belong to the input method, including Safari's legacy 229 event. */
export function isComposingKey(event: { isComposing?: boolean; keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
  return event.isComposing === true || event.keyCode === 229 || event.nativeEvent?.isComposing === true || event.nativeEvent?.keyCode === 229;
}

/** Use only for host submit handlers; ordinary accessible Enter activation remains native. */
export function isSubmitKey(event: { key: string; shiftKey?: boolean; defaultPrevented?: boolean; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.defaultPrevented && !isComposingKey(event);
}
