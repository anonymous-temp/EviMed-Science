/**
 * A server code in the reader's words, or a Chinese sentence saying it has no
 * words yet — never the code itself.
 *
 * The shell had fourteen `LABEL[code] ?? code` sites (2026-09-18 review, B §3
 * cross-cutting), so the day the server added a value the page printed it:
 * `needs_attention`, `version-family`, `timed out`. The sibling platform's hard
 * rule 1 is the whole reason this exists — every status, enum and error code
 * on screen goes through a Chinese mapping, and an unregistered code shows as
 * unregistered rather than as itself. The code stays available to whoever
 * needs it (an operator's tooltip, a support ticket) through the caller, not
 * through the label.
 */
export function labelFor(
  table: Readonly<Record<string, string>>,
  code: string | null | undefined,
  unregistered = "未登记的状态",
): string {
  if (!code) return unregistered;
  return Object.prototype.hasOwnProperty.call(table, code) ? table[code] : unregistered;
}

/**
 * The outcome words the operator ledgers write: the project audit (`started`, `completed`, `failed` — `audit()` and the
 * download settle in the server), and the security log, whose writers add the states a check or a channel can be in. A test
 * walks the server's source for every literal it writes (`statusLabel.test.ts`); a status it computes keeps the fallback.
 */
export const LEDGER_STATUS_LABEL: Readonly<Record<string, string>> = Object.freeze({
  started: "已开始",
  ok: "正常",
  partial: "部分完成",
  pending: "等待中",
  waiting: "等待中",
  stale: "已过时",
  expired: "已过期",
  refused: "已拒绝",
  reported: "已上报",
  unavailable: "不可用",
  unmounted: "未挂载",
  unreadable: "读不出来",
  completed: "已完成",
  succeeded: "成功",
  failed: "失败",
  denied: "已拒绝",
  allowed: "已允许",
  noop: "无变化",
  queued: "排队中",
  running: "运行中",
  canceled: "已取消",
  cancelled: "已取消",
  timed_out: "已超时",
  blocked: "已阻止",
});

/**
 * What the project audit's actions are called (`audit()` in the server): a closed list the server writes with a literal. An
 * action it does not know reads 「其他操作」 — a dotted identifier is the ledger's, and an operator who needs it has the
 * tooltip. 「command.…」 is any workspace command the page offered, by whichever name.
 */
export const AUDIT_ACTION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  "source.register": "登记资料",
  "file.upload": "上传文件",
  "file.download": "下载文件",
  "file.preview": "预览文件",
  "feedback.record": "记录反馈",
  "agent_run.cancel": "取消任务",
  "task.create": "创建任务",
  "task.cancel": "取消任务",
  "project.create": "新建项目",
  "project.rename": "重命名项目",
  "project.archive": "归档项目",
  "project.unarchive": "恢复项目",
  "project.export": "导出项目",
  "runtime.start": "启动运行时",
  "runtime.stop": "停止运行时",
  "runtime.restart": "重启运行时",
  "memory.settings.update": "更改记忆设置",
  "memory.record.update": "修改记忆",
  "memory.record.delete": "忘记记忆",
  "memory.record.undo": "撤销记忆变更",
  "memory.conflict.resolve": "处理记忆冲突",
  "memory.reset": "重置记忆",
  "research.handoff.create": "交接研究",
});

/** An audit action in words. */
export function auditActionLabel(action: string | null | undefined): string {
  if (action && action.startsWith("command.")) return "运行命令";
  return labelFor(AUDIT_ACTION_LABEL, action, "其他操作");
}

/**
 * What the workspace commands are called, for the operator's ledgers (`commands.mjs`). A command's snake-case name is the code's, not
 * page text: the ledger says what it does, and a command it has no word for reads 「其他命令」.
 */
export const COMMAND_LABEL: Readonly<Record<string, string>> = Object.freeze({
  start_runtime: "启动运行时",
  stop_runtime: "停止运行时",
  restart_runtime: "重启运行时",
  runtime_status: "查看运行状态",
  upload_file: "上传文件",
  add_files_to_workspace: "添加文件",
  add_text_to_workspace: "添加文字",
  save_to_knowledge_base: "存入知识库",
  read_artifact: "读取文件",
  resolve_artifact: "定位文件",
  preview_url: "预览文件",
  list_dir: "列出文件",
  write_workspace_file: "写入文件",
  save_text_file: "保存文本",
  claim_verification: "核对结论",
  record_provenance: "记录来源",
  list_provenance: "查看来源",
  record_run: "记录运行",
  list_runs: "查看运行记录",
  read_run_log: "读取运行日志",
});

/** A command in words. */
export function commandLabel(command: string | null | undefined): string {
  return labelFor(COMMAND_LABEL, command, "其他命令");
}

/**
 * What an audit row's target is in words, and the identifier behind it when it is one. A document's `src_…` is the platform's own id and
 * not something a person reads: the row says 「资料」 and the id is a copy button's. A path is shown as its file name (the whole path is
 * the tooltip and the copy), and a command is named by what it does.
 */
export function auditTarget(target: string | null | undefined, command: string | null | undefined): { text: string; id: string | null } {
  const value = (target ?? "").trim();
  if (!value) return { text: command ? commandLabel(command) : "项目", id: command ?? null };
  if (/^src_[A-Za-z0-9]+$/.test(value)) return { text: "资料", id: value };
  const path = value.replace(/^base:/, "");
  if (path.includes("/")) return { text: path.slice(path.lastIndexOf("/") + 1) || path, id: path };
  return /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(path) ? { text: commandLabel(path), id: path } : { text: path, id: null };
}

/** What the security log's actions are called (`auth.*` in the server); an action it has no word for reads 「其他操作」. */
export const SECURITY_ACTION_LABEL: Readonly<Record<string, string>> = Object.freeze({
  "auth.login": "登录",
  "auth.logout": "退出登录",
  "auth.register": "注册",
  "auth.password": "修改密码",
  "auth.oidc.start": "单点登录开始",
  "auth.oidc.callback": "单点登录完成",
  "auth.evimed.session": "会话",
  "auth.evimed.logout": "退出登录",
});

/** A security-log action in words. */
export function securityActionLabel(action: string | null | undefined): string {
  return labelFor(SECURITY_ACTION_LABEL, action, "其他操作");
}
