/**
 * What the platform offers a person who is not doing medical research: the
 * general group on the tools page, and the example prompts on a blank
 * conversation.
 *
 * Hidden knowledge: the tools page lists the capability packages
 * (`capability-display.json`, generated from each `capability.yaml`), and every
 * one of them is a professional deliverable with its own contract. Documents,
 * spreadsheets, slides, data analysis, web research and code are not capability
 * packages — they are what the base conversation does with the office skills,
 * the web tools and the workspace — so they have no capability to bind. A card
 * here therefore opens an ordinary conversation with a sentence in the composer
 * the reader can change before sending; nothing is bound and nothing is sent.
 * Putting these as starter prompts on a capability would bind the conversation
 * to a medical contract, which is the failure the base conversation exists to
 * avoid.
 *
 * The medical examples are the capabilities' own starter prompts, kept short
 * enough to read as a pill.
 *
 * @module @evimed/domain/src/generalTools
 */

/** The group of the tools page that holds {@link GENERAL_TOOLS}; it is listed before every other group. */
export const GENERAL_TOOL_GROUP = '通用'

/** The group the capability packages are listed under, whatever category their display block names. */
export const PROFESSIONAL_TOOL_GROUP = '医学专业'

/**
 * @typedef {object} GeneralTool
 * @property {string} id a stable key, never shown
 * @property {string} title the card's name
 * @property {string} description one complete sentence: what the tool does
 * @property {readonly string[]} starterPrompts sentences to start from; the first fills the composer when the card is chosen
 */

/** The general tools, in the order the group lists them. @type {readonly Readonly<GeneralTool>[]} */
export const GENERAL_TOOLS = Object.freeze([
  {
    id: 'documents',
    title: '文档',
    description: '读取、修改和新建 Word 与 PDF 文档，改一个条款而不动其余内容。',
    starterPrompts: [
      '把这份合同第 3 条的付款期限从 30 天改成 45 天，其他一个字都不要动。',
      '把下面的会议纪要整理成一份 Word：标题、与会人、三条决议、待办表。',
      '给这份 PDF 报告写一页摘要，并把第 5 页的表格导出成 Excel。',
    ],
  },
  {
    id: 'spreadsheets',
    title: '表格',
    description: '读取、修改和新建 Excel 工作簿，用真正的公式加列和合计。',
    starterPrompts: [
      '做一张 12 个月的预算表：收入、三项成本、利润用公式，最后一行合计。',
      '给这张表加一列同比增长，底部加合计行。',
    ],
  },
  {
    id: 'slides',
    title: '幻灯片',
    description: '新建多页演示稿，或在原文件上拆页、调序、整体换配色。',
    starterPrompts: [
      '做一个 10 页的商业计划 PPT：市场、产品、商业模式、竞争、团队、财务预测、融资需求。',
      '第 3 页太挤，拆成两页，整体换成深色配色。',
    ],
  },
  {
    id: 'data-analysis',
    title: '数据分析',
    description: '读取你上传的数据，汇总、画图，并说明口径和数字是怎么来的。',
    starterPrompts: [
      '分析一下我上传的销售数据：按地区和月份汇总销售额，放到新工作表，再画一张柱状图。',
      '哪些客户流失了？说清你的定义、数量和三条可能的原因，再画一条留存曲线。',
    ],
  },
  {
    id: 'web-research',
    title: '网页调研',
    description: '搜索并阅读官网和公开页面，写成带来源链接的结论或报告。',
    starterPrompts: [
      '调研国内三家云厂商的对象存储定价，做成对比表，附官网链接。',
      'Node.js 现在的 LTS 是哪个版本？什么时候结束维护？给官网链接。',
      '写一份国内咖啡连锁行业的调研报告，三页以内：市场规模、主要玩家、趋势，带来源链接。',
    ],
  },
  {
    id: 'code',
    title: '代码',
    description: '写脚本、改代码、让测试通过，并在工作区里运行验证。',
    starterPrompts: [
      '写一个 Python 脚本，把文件夹里的照片按拍摄日期重命名，要有 --dry-run。',
      '让这个项目的测试通过，不要改测试文件。',
    ],
  },
])

/**
 * @typedef {object} BlankExample
 * @property {string} label the short name on the pill
 * @property {string} draft the whole sentence that goes into the composer, never sent
 */

/** The pills on a blank conversation: general first, then two medical. @type {readonly Readonly<BlankExample>[]} */
export const BLANK_EXAMPLES = Object.freeze([
  { label: '整理会议纪要', draft: '把下面的会议纪要整理成一份 Word：标题、与会人、三条决议、待办表（负责人和截止日期）。' },
  { label: '做预算表', draft: '做一张 12 个月的预算表：收入、三项成本、利润用公式，最后一行合计。' },
  { label: '做演示稿', draft: '做一个 10 页的商业计划 PPT：市场、产品、商业模式、竞争、团队、财务预测、融资需求。' },
  { label: '调研对比', draft: '调研国内三家云厂商的对象存储定价，做成对比表，附官网链接。' },
  { label: '临床证据问答', draft: 'SGLT2 抑制剂在 eGFR 低于 30 的患者中还有肾脏获益吗？' },
  { label: '药品安全信号', draft: '比较阿托伐他汀与瑞舒伐他汀的肝损伤报告信号。' },
])
