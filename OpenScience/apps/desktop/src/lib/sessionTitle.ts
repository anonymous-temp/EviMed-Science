const defaultSessionTitle = /^New session(?:\s+-\s+(.+))?$/i;

export function displaySessionTitle(title: string | null | undefined): string {
  const value = title?.trim() ?? "";
  if (!value) return "科研会话";
  const match = defaultSessionTitle.exec(value);
  if (!match) return value;
  if (!match[1]) return "新科研会话";
  const created = new Date(match[1]);
  if (Number.isNaN(created.getTime())) return "新科研会话";
  return `科研会话 · ${new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(created)}`;
}
