import { BookOpen, BookText, Calculator, FlaskConical, Globe, Network, PenLine, Quote, Radar, Sparkles, Stethoscope, Wand2, type LucideIcon } from "lucide-react";

/**
 * The words the plugins page uses for what a conversation has to work with:
 * each plugin's Chinese name, the one line its row carries, and the two
 * sentences its drawer opens with.
 *
 * Kept as one table (not scattered over components) because these are the
 * product's own words for the platform's parts, and the research tool set's
 * 54 sentences live next to the tools they describe (`research-tools-zh.json`).
 */
export interface PluginCopy { title: string; use: string; does: string; icon: LucideIcon }

export const PLUGIN_COPY = {
  "dsh-cite": {
    title: "文献引用核对", icon: Quote,
    use: "查 DOI 和 PubMed 核对参考文献，按 GB/T 7714 或 Vancouver 排版",
    does: "回答或报告里出现参考文献时，按 DOI、PMID 查回原始书目记录，标出查不到或信息不一致的条目，再按你要的格式排版。",
  },
  "research-tools": {
    title: "医学研究工具集", icon: Stethoscope,
    use: "PubMed、ClinicalTrials.gov、openFDA、药品说明书等检索与计算工具",
    does: "对话里的研究都从这里取数和计算：检索文献、指南和试验登记，查药品说明书与不良反应，读取公开网页，并交给后台的计算引擎做统计。",
  },
  "web-read": {
    title: "网页阅读", icon: Globe,
    use: "读取公开网页和 PDF，遵守网站的抓取规则",
    does: "你给出一个网址，或研究需要某个公开页面时，读取它的正文并保存成可引用的快照；遵守网站的抓取规则，按站点限速。",
  },
  "dsh-annotation": {
    title: "划词批注", icon: PenLine,
    use: "在回答里选中一段话，直接追问或批注",
    does: "在回答里选中一段话，可以直接就这一段追问，或留下批注，对话会带着你选中的原文继续。",
  },
  "dsh-mermaid": {
    title: "Mermaid 图表", icon: Network,
    use: "把回答里的流程图代码画成图，例如 PRISMA 流程图",
    does: "回答里的流程图代码会画成图，可以在图和代码之间切换，适合 PRISMA 流程图、研究路线和分类图。",
  },
} as const satisfies Record<string, PluginCopy>;
export type PluginCopyId = keyof typeof PLUGIN_COPY;

/** What the citation tools do, by the tool name the plugin lists. A tool without a sentence is not shown: a name is not a description. */
export const CITATION_TOOL_COPY: Readonly<Record<string, string>> = {
  cite_lookup: "按标题、DOI 或 PMID 查找文献书目",
  cite_format: "把参考文献排成 GB/T 7714 或 Vancouver 等格式",
  cite_bibtex: "导出 BibTeX",
  cite_check: "核对引用是否存在、信息是否一致",
};

/**
 * The calculation engines, in the order the page lists them. `id` is what the server reports readiness under (the engine's
 * tool name, and `vcr` for the clinical-research statistics engine).
 */
export interface EngineCopy { id: string; title: string; /** The name inside a sentence listing several: 「药物警戒、文献计量」. */ short: string; use: string; icon: LucideIcon }
export const ENGINE_COPY: readonly EngineCopy[] = [
  { id: "meta_analysis", title: "Meta 分析引擎", short: "Meta 分析", icon: Calculator, use: "效应量合并、异质性、漏斗图与 Egger 检验，由程序确定性计算" },
  { id: "vcr", title: "临床研究统计引擎", short: "临床研究统计", icon: Calculator, use: "合成人群、虚拟患者、外部对照与试验模拟" },
  { id: "mendelian_randomization", title: "孟德尔随机化引擎", short: "孟德尔随机化", icon: Calculator, use: "IVW、MR-Egger、加权中位数与敏感性分析" },
  { id: "drug_safety_analysis", title: "药物警戒引擎", short: "药物警戒", icon: Calculator, use: "不良反应信号检测与安全性报告，统计量由程序计算" },
  { id: "bibliometric_analysis", title: "文献计量引擎", short: "文献计量", icon: Calculator, use: "PubMed 文献的网络分析、研究前沿与可视化报告" },
  { id: "peer_review", title: "论文审稿引擎", short: "论文审稿", icon: Calculator, use: "按多套报告规范对稿件做同行评议" },
  { id: "research_topic_selection", title: "科研选题引擎", short: "科研选题", icon: Calculator, use: "检索证据、梳理空白，提出可检验的研究方向" },
];

/** Where each skill group's rows get their icon. */
export const SKILL_GROUP_ICON: Readonly<Record<string, LucideIcon>> = {
  我的技能: BookOpen,
  科研分析: FlaskConical,
  写作与核查: BookText,
  办公文档: Wand2,
  社区: Sparkles,
  循证传播: Radar,
};

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
