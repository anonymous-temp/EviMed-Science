import { BookOpen, BookText, FlaskConical, Lightbulb, Radar, Repeat, Wand2, type LucideIcon } from "lucide-react";

/**
 * Words and marks the plugins and skills page keeps of its own. What the platform's plugins and tools are called, what they
 * do and how they are used is not here: it is `runtime-inventory-zh.json`, which the server hands the page (R19 — a table of
 * installed things typed into the page is how 长任务 and the memory plugin stayed off it).
 */

/**
 * Where each skill group's rows get their icon. The method pack's group is not in this table: the server names it (`geoGroup`),
 * and the list marks it with the radar the sidebar gives that module, so no page spells the module's name here.
 */
export const SKILL_GROUP_ICON: Readonly<Record<string, LucideIcon>> = {
  我的技能: BookOpen,
  通用: Lightbulb,
  科研分析: FlaskConical,
  写作与核查: BookText,
  办公文档: Wand2,
};
/** The long task's entry skill, by the group the server names (`loopxGroup`). */
export const SKILL_LOOPX_ICON: LucideIcon = Repeat;
export const SKILL_PACK_ICON: LucideIcon = Radar;

/**
 * Chinese labels for the settings a package's schema names. A key with no label here is shown as 「其他设置」: a raw key such
 * as `timeoutMs` is the program's word, never the reader's.
 */
const SETTING_LABELS: Readonly<Record<string, string>> = {
  timeoutMs: "请求超时（毫秒）",
  timeoutSeconds: "请求超时（秒）",
  timeout: "请求超时",
  maxResults: "返回条数上限",
  language: "语言",
  style: "格式",
};
export const settingLabel = (key: string): string => SETTING_LABELS[key] ?? "其他设置";
