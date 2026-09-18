# D · EviMed 视觉设计系统调研（2026-09-18）

> 状态：**进行中**（每完成一个问题即更新本文件，以便中断后保留成果）
> 作者：设计调研（Claude Opus 5）· 日期 2026-09-18
> 范围：仅调研与提案，**不修改任何代码文件**。
> 标注约定：凡非显而易见的结论都给 URL；无来源的判断显式标为 **【设计判断】**。

## 0. 结论速览

1. **现状的暖米 + 赭红，在色相、明度与用法上与 Claude 官方 DESIGN.md 同构**
   （`#f7f5ef`/`#b24f2a`/`#2a2723` vs `#faf9f5`/`#cc785c`/`#141413`）。
   一个卖"医学可信度"的临床工具撞上通用聊天助手的品牌色，是定位问题，不只是重复问题。
2. **三套色系里有一套是不合规的**：框架送信按钮 `rgb(65,118,230)` 配白字实算 **4.23:1**，
   低于 WCAG AA 的 4.5:1。这不是意见。
3. **现有浅色 token 是一组压线值**（4.51–4.93:1），任何色值微调都会掉下去；
   新方案的同类组合在 5.16–6.40:1。
4. **框架可以被彻底收编**：实测它暴露 **358 个 `--dsw-*` 变量**，是标准的
   primitive / alias / specific 三层，与我们的语义层一一对应；
   连那个蓝色渐变的「深度求索中...」都有自己的变量（`--dsw-linear-gradient-think`）。
5. **推荐方向 A「循证青」**：冷中性纸 + 深青绿（`#00756b`）。
   它把三套色系收敛到**已经存在的 favicon `#1f6f5c`** 上，把红完全释放给危险与未读，
   在中文语境下不踩红绿反转，且与 NHS / Elicit 同族。方向 B「学刊墨」是低迁移成本的备选。
6. **正文字号与行宽今天壳与框架不一致**（15px/760px vs 16px/680px）。
   760px 的 15px 中文是 **50 字/行**，超出 35–45 字的建议区间。统一为 **16px / 680px**。
7. **中英混排空格在 2026 年可以交给 CSS**：`text-autospace` 三家浏览器都已支持
   （Chrome 140 / Firefox 145 / Safari 18.4），但初始值都是 `no-autospace`，**必须显式写**。
   这是本次调研最可操作的一条。
8. **长任务不要进度条**。行业共识已经明确：代理的百分比在结构上未定义。
   给 odometer（已用时 / token / 步数 / 已写出的产物）+ 可中断。
   内核的 `ui-plan` / `ui-subagent` / `ui-deliverables` 已经在跑，不需要新建管道。
9. **核验标记 ✓/⚠ 必须与临床告警分开**：告警疲劳（覆盖率 49–96%）+ 中文红绿反转 +
   WCAG 1.4.1 三条独立理由指向同一个结论 —— ⚠ 用琥珀软底、空心问号，永不用红、永不用三角感叹号。
10. **两项当前不合规的尺寸**：铃铛图标 14×14（WCAG 2.5.8 要求 ≥24×24）；
    右栏 528px 比中栏 680px 还接近，第三栏不应与主阅读列争主导。

---

## 前置：DESIGN.md 这套约定到底规定什么

`DESIGN.md` 是放在仓库根目录、给 AI 编码代理读的设计系统文件，由 Google Stitch 提出，
经 `VoltAgent/awesome-design-md` 推广成社区约定（2026-03-31 首次出现，2026-08 已收 73 份真实站点提取的文件）。
来源：<https://betterstack.com/community/guides/ai/design-md-ai/>、<https://github.com/voltagent/awesome-design-md>。

**实测结构**（我下载了 `claude` / `linear.app` / `stripe` / `notion` / `vercel` 五份原文核对，五份结构完全一致）：

文件 = **YAML frontmatter（机器可读 token）** + **Markdown 正文（人读的意图与规则）**。

frontmatter 顶层键固定为八个：

```
version, name, description, colors, typography, rounded, spacing, components
```

- `colors:` 扁平的 `名称: "#hex"` 表，名称是**角色名**不是色相名（`primary` / `on-primary` /
  `ink` / `ink-muted` / `canvas` / `surface-1..4` / `hairline` / `semantic-success` …）。
- `typography:` 每档一个对象，键为 `fontFamily / fontSize / fontWeight / lineHeight / letterSpacing`。
- `components:` 每个组件一个对象，值**用 `{colors.x}` / `{typography.y}` / `{rounded.z}` 引用 token**，
  而不是写死色值 —— 这是这套约定最重要的一条：组件层不出现字面量。

正文固定章节序列（五份一致）：

```
## Overview            —— 这个界面"是什么气质"，3–6 条 Key Characteristics
## Colors              —— Brand & Accent / Surface / Text / Semantic 四组，每色一句"用在哪、不用在哪"
## Typography          —— Font Family / Hierarchy / Principles / Note on Font Substitutes
## Layout              —— Spacing System / Grid & Container / Whitespace Philosophy
## Elevation & Depth   —— 阴影档位 + Decorative Depth
## Shapes              —— Border Radius Scale
## Components          —— 按钮 / 卡片 / 输入 / 导航 / 徽章 / 表格 / 签名组件
## Do's and Don'ts
## Responsive Behavior —— Breakpoints / Touch Targets / Collapsing Strategy / Image Behavior
## Iteration Guide     —— 允许改什么、不许改什么
## Known Gaps          —— 没观察到的部分，明说
```

`Known Gaps` 和 `Iteration Guide` 是这套约定里最被低估的两节：它们把"这份文件没说的事"显式化，
避免代理拿不确定的地方自由发挥。EviMed 的 `DESIGN.md` 必须带这两节。

**对 EviMed 有直接冲击的一条发现**：Claude 官方 DESIGN.md 的配色是
`canvas #faf9f5`（暖奶油）+ `primary #cc785c`（珊瑚/赤陶）+ `ink #141413`，
并且它自述这是"刻意与其他 AI 品牌的冷蓝/石板灰对立"的定位色。
而 EviMed 现状是 `--bg #f7f5ef` + `--accent #b24f2a` + `--text #2a2723` ——
**色相、明度关系与用法几乎是 Claude 品牌的同构复制**。
（Claude 值来源：<https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/claude/DESIGN.md>；
EviMed 值来源：`OpenScience/apps/web/src/index.css:15,20,28`。）
这对一个要显"医学可信度"的临床工具是双重不利：既不像临床器械，又像在蹭某个聊天助手的外观。

参考基线（同样从原文 frontmatter 摘出，用于校准"冷静专业"这一档的实际取值）：

| 产品 | primary | canvas / surface | ink | 备注 |
|---|---|---|---|---|
| Claude | `#cc785c` 珊瑚 | `#faf9f5` / `#efe9de` | `#141413` | 暖奶油 + 珊瑚，编辑部气质 |
| Linear | `#5e6ad2` 靛 | `#010102` / `#0f1011` | `#f7f8f8`（暗底） | 近黑画布，极窄色域 |
| Stripe | `#533afd` 紫 | `#ffffff` / `#f6f9fc` | `#0d253d` 深海军蓝 | 蓝墨 + 冷白，`hairline #e3e8ee` |
| Notion | `#5645d4` 紫 | `#ffffff` / `#f6f5f4` | `#1a1a1a` / `#37352f` | 中性暖灰面，彩色只在插图 |
| Elicit（实测其站点 HTML） | `#083d44` 深墨绿 | `#fcfcf8` 米白 | — | 学术检索工具，唯一用"深墨绿 + 米白"的 |

Elicit 取值来源：抓取 <https://elicit.com> 首页 HTML 内联样式，出现频次 `#083d44`×66、`#fcfcf8`×6、
`#026370`、`#e5ff96`（柠檬绿强调色）。
Consensus 实测使用 Tailwind v4（输出 `oklch()` 调色板）并自定义了一组极浅语义底色：
`--color-green-faint:#cef9eb`、`--color-red-faint:#fde3e3`、`--color-yellow-faint:#fff1c6`、
`--color-orange-faint:#feecd6`（抓取 <https://consensus.app> 的 CSS bundle）。
—— 这印证了一条趋势：**科研类产品的语义色走"极浅底 + 深字"而不是"实色块"**。

---

## 1. 医学 / 科研 / AI 产品的色彩

### 1.1 医疗 UI 的硬约束：红色是被征用的

**NHS 数字服务手册**（英国国民医疗服务体系官方设计系统，医疗 UI 最权威的公开规范）
<https://service-manual.nhs.uk/design-system/styles/colour>：

- 调色板（实测抓取）：Red `#d5281b`、Yellow `#ffeb3b`、Green `#007f3b`、Aqua-green `#00a499`、
  Blue `#005eb8`（NHS Blue，主品牌色）、Dark-blue `#003087`、Purple `#330072`、
  Dark-pink `#7c2855`、Pink `#ae2573`、Orange `#ed8b00`、Warm-yellow `#ffb81c`、Pale-yellow `#fff9c4`、
  Black `#212b32`、Grey-1 `#4c6272`、Grey-2 `#768692`、Grey-3 `#aeb7bd`、Grey-4 `#d8dde0`、Grey-5 `#f0f4f5`。
- **红只留给紧急/急诊卡片**（urgent care cards）。NHS 品牌规范进一步说明 "Emergency Services Red"
  虽非专属，但因其与急救的强关联，用于其他用途必须极谨慎
  （<https://www.england.nhs.uk/nhsidentity/identity-guidelines/colours/>）。
- **颜色不得独自承载语义**："what the colour is 'saying' is available in other ways"。
- **避免红底绿字 / 绿底红字**表达"好/坏"，因为红黄绿正是最常见色觉障碍的混淆区。
- 对比度基线：WCAG 2.2 AA 小字 4.5:1、大字与图形组件 3:1；AAA 为 7:1 / 4.5:1。

注意 NHS 的**主色是蓝 `#005eb8`**，不是绿也不是红。医疗 UI 里"可信"的默认色相是蓝与青绿，
红被彻底征用给危险。

### 1.2 告警疲劳：红色预算是临床产品的第一性约束

EHR 文献里的量化结论：临床医生对药物-药物相互作用告警、打断式警告等的**覆盖（override）率是 49%–96%**；
告警数量上升时，医生对**所有**告警的接受度一起下降，每条告警的效力被稀释
（<https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9754301/>、
<https://ncbi.nlm.nih.gov/pmc/articles/PMC4173170>、
<https://pubmed.ncbi.nlm.nih.gov/39049299/>）。
人因工程的跨行业综述（航空/核电/汽车）同样把"告警分级与数量预算"列为第一原则
（<https://patientsafetyj.com/article/73905-informing-healthcare-alarm-design-and-use-a-human-factors-cross-industry-perspective>）。

**对 EviMed 的直接含义**：仓库已有的"阻断点预算 6 个"（平台开发原则 4）是同一条规律在门禁上的投影；
它必须在**视觉层**也有对应物 —— **红色预算**。当前实现违反了它：
主按钮、分类标签、未读徽标共用同一支赭红 `#B24F2A`（`00-live-findings.md` F7）。
一个"未读 2 条"的徽标和一个"去配置"的主按钮和"临床证据"分类标签同色，等于把强调色的注意力价值花光。

### 1.3 中国语境：红绿的含义与西方相反

中国（及台湾、日本）股市"红涨绿跌"，欧美"绿涨红跌"，方向完全相反
（<http://caijing.chinadaily.com.cn/2015-07/27/content_21415547.htm>、
<https://www.163.com/dy/article/KHFURR1R05562F45.html>、<https://m.ui.cn/details/665942>）。
红在中文语境里首先是**喜庆/重要/上涨**，其次才是危险。

**含义**：面向中国临床用户的产品，**红绿二元不能单独承担"通过/不通过"**。
EviMed 的核查标记（✓ 已核验 / ⚠ 待核）尤其不能落成"绿勾/红叉"——
一个中国药师看到红色更可能读成"重点"而不是"错了"。必须靠**图形 + 文字**先说清楚，颜色只做次级编码。
这与 WCAG 1.4.1 的要求方向一致，不是额外成本。

### 1.4 色觉障碍安全的状态编码

WCAG 2.2 SC 1.4.1（Level A）原文：
"Color is not used as the only visual means of conveying information, indicating an action,
prompting a response, or distinguishing a visual element."（<https://www.w3.org/TR/WCAG22/>）

实践共识是**冗余编码**（同一信息走多条通道，断一条不丢信号）：
颜色 + 图标形状（✓ / ! / ×）+ 文字标签；复杂系统再加形状分级（圆/方/三角）与填充图案
（<https://www.accessibility.chat/articles/when-color-coding-fails-why-status-indicators-need-more-than-pretty-colors>、
<https://dev.to/pasindu_balasooriya/when-red-means-nothing-designing-colour-blind-safe-uis-for-emergency-dispatch-systems-40lj>）。

仓库现状已有一条同类结论写在 `docs/ui-ux-audit/02-前端设计规范建议.md` §2.1：
侧栏会话圆点恒绿（`Sidebar.tsx:155-159`）—— 颜色单独承载且值还是错的。

### 1.5 小结：EviMed 应当去哪个色相

三套色系（赭红壳 / 蓝框架 / 绿 favicon）必须收敛为一套。可选的"可信"色相只有三类：

1. **蓝**（NHS、Stripe、Linear、UpToDate 一路）：医疗 UI 的默认可信色，但正是当前 iframe 的蓝
   `rgb(65,118,230)`，且与 logo 蓝 `#2563EB` 同族 —— 收敛成本最低，代价是**毫无辨识度**，
   且与 DeepSeek/通用 AI 聊天产品撞脸。
2. **深青/墨绿**（Elicit `#083d44`、NHS Aqua-green `#00a499`、favicon `#1f6f5c`）：
   学术检索工具的实际选择；在中文语境里绿不与"下跌/错误"绑定（因为红绿含义反转，绿=跌属于弱关联），
   且与"红=危险"不冲突；深到 L≈30% 时读起来像"墨水"不像"提示"。
3. **深靛/墨蓝偏紫**（Stripe `#533afd`、Notion `#5645d4`、Linear `#5e6ad2`）：SaaS 味重，医学可信度弱。

**【设计判断】** 第 2 类是唯一同时满足"医学可信 + 中文语境安全 + 与红色预算不冲突 + 有辨识度"的选择。
第 1 类作为保守备选。第 7 节给出两个具体方向并推荐其一。

---

## 2. Token 方法论

### 2.1 分层：primitive → semantic → component（三层，不是两层）

- **Carbon（IBM）** 把颜色抽象为**按角色命名的 token**，token 与色值分离，主题文件负责把角色映射到具体值；
  组件层只写 `$text-02` 这类角色名，绝不写 hex。token 可嵌套（`$interactive` → `$blue-60`）。
  Carbon 还定义 **layering model**：浅色主题里层与层在 White 与 Gray 10 之间交替，
  深色主题里每加一层就亮一档。
  （<https://carbondesignsystem.com/elements/color/overview/>、
  <https://carbondesignsystem.com/elements/themes/overview/>）
- **DESIGN.md 约定**的 `components:` 块是同一思想的 Markdown 形态：组件值只允许 `{colors.x}` 引用。
- EviMed 现状是**两层**：`index.css` 的 CSS 变量（语义层）+ `tailwind.config.js` 的映射。
  缺的是 primitive 层（色阶），所以"把 `--accent` 调深一档"这种操作在现状下只能手工试色 ——
  `index.css:25-34` 的那几行注释正是手工试色的痕迹。补一层 50–950 色阶即可消除。

### 2.2 12 档 vs 11 档：用 Radix 的**角色定义**，用 Tailwind 的**档位命名**

Radix Colors 12 档的角色表（原文逐字）
（<https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale>）：

| Step | Intended Use |
|---|---|
| 1 | App background |
| 2 | Subtle background |
| 3 | UI element background |
| 4 | Hovered UI element background |
| 5 | Active / Selected UI element background |
| 6 | Subtle borders and separators |
| 7 | UI element border and focus rings |
| 8 | Hovered UI element border |
| 9 | Solid backgrounds |
| 10 | Hovered solid backgrounds |
| 11 | Low-contrast text |
| 12 | High-contrast text |

并给出硬保证："Steps `11` and `12`—which are designed for text—are guaranteed to
Lc 60 and Lc 90 APCA contrast ratio on top of a step `2` background from the same scale."
暗色模式规则：暗色下 app 背景用同一色阶的 step 1 或 2，而不是把浅色值反过来；
`AppBg` 是一个随模式改变指向的 **mutable alias**。

**【设计判断】** EviMed 已在 Tailwind 生态里，档位命名用 50–950（11 档）成本最低；
但**角色分配照搬 Radix 的语义**（哪档做边框、哪档做实底、哪档做低对比文字），
这样既不引入 Radix 依赖，又拿到经过验证的角色划分。映射：
Radix 1/2 ≈ 50，3/4/5 ≈ 100/200，6/7/8 ≈ 200/300/400，9/10 ≈ 600/700，11 ≈ 700/800，12 ≈ 900/950。

### 2.3 OKLCH：色阶必须在感知均匀空间里生成

Tailwind v4（2025-01）把整套默认调色板**从 RGB 重新推导为 OKLCH**，理由是感知均匀 + 可表达 P3 广色域
（<https://tailwindcss.com/blog/tailwindcss-v4>）。
OKLCH 的实用价值：L=50% 时不同色相看起来**一样亮**，于是"蓝主按钮换成绿主按钮而文字仍可读"这件事
从试错变成计算（<https://trypeek.app/blog/oklch-explained-what-it-is-why-tailwind-v4-uses-it-how-to-convert/>）。

**Adobe Leonardo** 走得更远：不是选完色再测对比度，而是**按目标对比度直接生成色**
（<https://github.com/adobe/leonardo>、<https://adobe.design/toolkit/leonardo>）。
这正是 EviMed 需要的：`--muted` / `--accent` / `--warn` / `--ok` / `--error` 五个 token
在 2026 年被逐个手工加深以够 4.5:1（`index.css:21-34` 注释里记着旧值），
下一次加深仍会是手工的 —— 除非色阶本身是按对比度生成的。

**建议的生成规则**：每条色阶用固定 L 序列 + 色相自身的最大可用 C（在 sRGB 内夹紧），
L 序列取 `{50:0.975, 100:0.945, 200:0.892, 300:0.812, 400:0.708, 500:0.630, 600:0.556, 700:0.478, 800:0.402, 900:0.330, 950:0.240}`。
这套 L 序列**保证**：浅底（50/100）上放 700 及以上必过 4.5:1；深底（800/900）上放 100/200 必过。
第 7 节给出实算值。

### 2.4 暗色不是取反，是换一条色阶的取值点

Radix 的规则（上引）与 Carbon 的 layering model 一致：暗色下背景取同色阶的低档，
面层每加一层亮一档，**语义 token 名不变、指向变**。
EviMed 现状已经是这个形状（`[data-theme="dark"]` 重绑同名变量），只是色值是手挑的而非从色阶取的。

一条必须补的规则：**暗色下强调色要提亮并降饱和**。现状 `--accent` 从 `#b24f2a` 变成 `#d0764f`
方向正确，但没有规则可复用。规则应写成："暗色取 400 档，浅色取 700 档"。

### 2.5 可访问性目标（写死在规范里）

WCAG 2.2 原文（<https://www.w3.org/TR/WCAG22/>）：

| 准则 | 级别 | 原文 | EviMed 目标 |
|---|---|---|---|
| 1.4.1 Use of Color | A | "Color is not used as the only visual means of conveying information…" | 强制；状态一律 颜色+图标+文字 |
| 1.4.3 Contrast (Minimum) | AA | 正文 4.5:1，大字 3:1 | 强制 |
| 1.4.11 Non-text Contrast | AA | UI 组件与图形对象 ≥3:1 | 强制（边框、图标、图表轴） |
| 2.4.11 Focus Not Obscured (Minimum) | **AA** | "the component is not entirely hidden due to author-created content" | 强制（吸顶输入框/横幅会挡焦点） |
| 2.4.12 Focus Not Obscured (Enhanced) | AAA | "no part of the component is hidden" | 尽量 |
| 2.4.13 Focus Appearance | **AAA**（曾拟为 AA，因风险降级） | 焦点圈面积 ≥ 2 CSS px 周长环，且焦点/非焦点同像素对比 ≥3:1 | 采纳为内部基线 |
| 2.5.8 Target Size (Minimum) | AA | 点击目标 ≥ 24×24 CSS px；不足时可用"24px 直径圆不重叠"的间距豁免 | 强制 |

2.5.8 的间距豁免原文解释见
<https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>。
**现状违规点**：收件箱铃铛图标 14×14（F7），远小于 24×24，且徽标压在图标上——
既违 2.5.8 也让图标本身不可读。

APCA 说明：Radix 用 APCA（Lc 60 / Lc 90）而不是 WCAG 2.x 的比值，因为它更贴近人眼对文字的感知。
**【设计判断】** EviMed 应以 **WCAG 2.2 AA 比值为合规基线**（可审计、可自动化、是法规引用的那一套），
以 **APCA Lc 值为设计侧的参考**（尤其是浅色小字与深底大字这两个 WCAG 2.x 已知失真区）。
不要用 APCA 替代合规判定：它尚未进入任何 AA 规范。

---

## 3. 中英混排科研阅读的字体排印

### 3.1 系统字体栈：四个平台四张脸

| 平台 | 默认可用中文无衬线 | 备注 |
|---|---|---|
| macOS / iOS | PingFang SC（苹方） | Apple 把它归入 SF Pro 家族（SF Pro SC/TC/HK 即苹方系列）<https://developer.apple.com/fonts/> |
| Windows | Microsoft YaHei（微软雅黑） | Win7+ 默认；**SimSun（中易宋体）在正文字号是点阵渲染**，放大后崩坏 |
| HarmonyOS / 华为 | HarmonyOS Sans SC | 华为 + 汉仪，2021-06-08 发布，**个人与企业免费商用**<https://zhuanlan.zhihu.com/p/680004582> |
| 小米 / MIUI | MiSans | 小米 + 汉仪，2021-12 发布，免费商用 |
| Linux / Android / 容器 | Noto Sans CJK SC = Source Han Sans SC | 同一套字体的两个发行名 |

**一条 2026 年的新事实**：Chromium 在 Windows 上**改为优先使用本地已安装的 Noto CJK**，
理由是 `text-spacing-trim`（M123 起）和 `font-variant-east-asian` 需要的 OpenType 特性，
Windows 自带 CJK 字体没有；Noto CJK 的设计定位类似 macOS 的 Hiragino，更适合网页
（blink-dev PSA: <https://groups.google.com/a/chromium.org/g/blink-dev/c/t1Mc7oJdNQY>）。
**但不要依赖它**：同一社区随后记录了回归 —— 在约 96 PPI 的普通显示器上，Noto 的小字因缺少 hinting
而发虚，不如微软自带字体锐利，于是又有 "Prefer Microsoft fonts over Noto on Windows whenever available"
的 issue（<https://issues.chromium.org/issues/409486609>）。
结论：**字体栈必须自己写全，不能指望浏览器默认**。仓库 2026-09-16 已经修过一次同类问题
（`index.css:85-97` 的注释：此前 `Inter, system-ui` 没有点名任何中文字体，Windows 上落到 SimSun）。

### 3.2 中文衬线做正文：不可以（除非自托管并做子集）

两条独立原因：

1. **Windows**：`serif` 回退到 SimSun，正文字号是点阵字形；这是中文网页排版里最常被点名的一条
   （<https://weixiang.github.io/posts/the-font-selection-and-development-guide-in-chinese-web-pages/>、
   <https://woft.name/wp/get-rid-of-ugly-chinese-bitmap-characters/>）。
2. **iOS / iPadOS 不预装任何 CJK 衬线**，`serif` 在中文上直接落回无衬线 —— 设计意图彻底丢失（同上来源）。

所以中文衬线要么**自托管 Source Han Serif / Noto Serif CJK SC 并做子集**（全量一个字重约 20 MB 级，
必须按字频子集化才能上生产），要么**只用于标题**。
仓库现状恰好是后者：`tailwind.config.js:24-28` 的注释记录 `font-serif` 共 31 处、全是中文页面标题。
**保持这个用法，不要把衬线推进正文。** 【设计判断】

反过来，**拉丁文衬线做长文正文是可行且有价值的** —— `Source Serif 4` 已在依赖里
（`index.css:4-5`）。但一份中英混排的证据报告里，中文段落用黑体、英文句子用衬线会产生"两种质地"，
在同一段里跳动。**【设计判断】结论：报告正文中英统一用无衬线；衬线只出现在报告标题、章节标题、
以及纯拉丁的参考文献块。**

### 3.3 字号与行高：两套中文设计体系收敛到同一个数

- **Ant Design**：正文主字号 **14px，行高 22px**（比值 1.571）；字重只用 400 / 500，
  强调英文用 600；并明确要求"层级克制在 3–5 档"；仪表盘数字加 `font-variant-numeric: tabular-nums`
  （<https://ant.design/docs/spec/font-cn/>）。
- **TDesign（腾讯）**：行高公式 **`line-height = font-size + 8`**，作者自述这是为了与"1.5 倍常用行高"
  对齐且让整体行距稳定；字重只提供 400 / 600
  （<https://tdesign.tencent.com/design/fonts>，规范摘要见 <https://modao.cc/ad/blog/TDesign-component-library.html>）。

两者在 14px 上给出同一个行高 22px。EviMed 现状 `ui: 13.5px/1.55`（=20.9px）、`body: 15px/1.65`（=24.75px）
落在同一带里，方向正确；问题在于 **13.5px 这种半像素档**会导致亚像素舍入不一致，
且 `ui` 与 `ui-sm`（13px）只差 0.5px，实际上是**同一档伪装成两档**。【设计判断：应合并】

**中文行高下限**：中文字身框满格、无上下伸部，同字号下比拉丁更需要行距；
中文排版通行建议是行距取字号的 1.5–2 倍作为行间距参考
（<https://m.ui.cn/details/567154>）。科研长文取 **1.7–1.8**，UI 列表取 **1.5–1.55**。

### 3.4 行宽（measure）：EviMed 现在的对话列太宽

中文排版的行长建议：**14px 字号下每行 35–45 字**；移动端 30–40 字符；
通用（拉丁）40–60 字符（<https://m.ui.cn/details/567154>、
<https://www.woshipm.com/pd/5823078.html>、<https://zhuanlan.zhihu.com/p/207951692>）。

算一下现状：`max-w-content = 760px`（`tailwind.config.js:52`），正文 15px。
一个中文字在 15px 下宽 15px，**760 / 15 ≈ 50.7 字/行** —— 超出 45 字上限。
而实测框架内正文是 **16px**（F7），16px 下 kernel 中心列在 1440 视口是 680px → 42.5 字/行，**反而更合适**。

**→ 壳与框架的正文字号（15 vs 16）和行宽（760 vs 680）今天是不一致的两套。**
建议统一为 **16px / 680px（≈42 字/行）**，见第 8 节。

### 3.5 中英混排空格：2026 年可以交给浏览器了

这是本次调研**最可操作的一条新发现**。

`text-autospace` 在 CJK 与拉丁字母/数字之间自动插入 1/8 em 间隙。MDN 浏览器兼容数据（权威主源）：

| 属性 | Chrome / Edge | Firefox | Safari |
|---|---|---|---|
| `text-autospace` | **140** | **145** | **18.4** |
| `text-spacing-trim` | **123** | ✗（<https://bugzil.la/1951795>） | ✗（<https://webkit.org/b/252068>） |

来源：<https://github.com/mdn/browser-compat-data>（`css/properties/text-autospace.json`、
`css/properties/text-spacing-trim.json`，2026-09-18 拉取）。

**关键坑**：三家浏览器的实现都把**初始值做成了 `no-autospace` 而不是规范写的 `normal`**
（MDN BCD notes 指向 <https://github.com/w3c/csswg-drafts/issues/12386>）。
也就是说 **必须显式写出来才会生效**：

```css
text-autospace: ideograph-alpha ideograph-numeric;
```

语义（<https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace>）：
`ideograph-alpha` = 汉字与拉丁**字母**之间加空；`ideograph-numeric` = 汉字与**数字**之间加空；
未写 `insert`/`replace` 时按 `insert` 处理（已有空格就不重复加）。
Chrome 的说明补充：若正文里已有显式空格，不会重复插入，所以**存量内容不需要改写**
（<https://developer.chrome.com/blog/css-i18n-features>）。

对 EviMed 的价值极高：报告正文全是 `阿司匹林ASPREE研究（n≈19,114）在≥70岁人群` 这种串，
今天要么模型手打空格（不稳定、且会被"字节级引文核验"当成差异），要么难看。
**用 CSS 解决，不要用模型解决** —— 这正好对应仓库原则 1（确定性属性归代码）。

`text-spacing-trim: normal`（标点挤压）只有 Chromium 支持，**作为渐进增强加上**，
不支持的浏览器忽略，无副作用。W3C clreq 把中西混排间距标为 "advanced"，
并记录了浏览器长期缺失的历史（<https://www.w3.org/TR/clreq-gap/>、<https://www.w3.org/TR/clreq/>）。

### 3.6 数字、标识符、等宽

- **表格与计时器**：`font-variant-numeric: tabular-nums`（Ant Design 明文要求）。
  EviMed 的证据矩阵、用量（54.8K tok）、耗时（26分53秒）、剂量、置信区间全部适用。
- **标识符**：DOI、PMID、NCT 号、run id、claim id 用等宽（`JetBrains Mono` 已在栈里）。
  理由不是美观而是**可逐字符核对** —— 这是一个引文核验产品的本职。
  截图 `13-chat-tool-row-clicked.png` 里工具输出的 DOI 列表已经是等宽，效果正确；
  但正文里的 `doi:10.1056/NEJMoa1800722` 用的是正文字体，两处不一致。
- **不要给中文加 `letter-spacing`**：中文字身框已含边距，额外字距会破坏字块节奏。【设计判断】

### 3.7 字重

Ant Design 与 TDesign 都只用两到三个字重（400 / 500 / 600）。
中文在屏幕上**没有真正的 500**：多数中文字体只有 Regular 与 Bold，
`font-weight: 500` 在 Windows 上通常合成或直接回落到 400。
**→ 规范只允许 400 / 600 两档，500 不进 token。【设计判断】**
（EviMed 现引入了 Inter 400/500/600 三档 —— 500 只对拉丁有效，用在中英混排标题上会造成
"英文变粗、中文没变"的错位。）

## 4. 研究工作台的布局与密度

### 4.1 三栏的通行做法

VS Code / Linear / Slack 是同一个形状：**可拖宽的左栏 + 弹性中栏 + 可收起的第三栏**；
共同要求是 —— 拖到阈值以下整栏隐藏、支持键盘、**布局跨会话持久化**、可吸附到 25/33/50/67/75% 档位
（<https://www.techinterview.org/post/3233475299/build-resizable-panels-layout-vscode-linear/>、
<https://code.visualstudio.com/docs/configure/custom-layout>）。
实现上以 CSS Grid 命名列 + 把拖柄做成独立的窄列（约 6px）为标准写法。

EviMed 实测（`00-live-findings.md` F2，1440 视口、框架 1208px）：
`280px 400px 528px` 的网格，中心列 680、右栏 528。**右栏比中心列还宽是异常的** ——
第三栏是辅助面板，不应与主阅读列争夺视觉主导。
Linear/VS Code 的常见比例是右栏 ≈ 左栏的 1.0–1.5 倍，且**永远窄于中栏**。
建议：右栏默认 360px、可拖 320–480，中栏保底 640px；视口不足时右栏改为覆盖层（overlay）。【设计判断】

另一处：F2 记录 1440 下打开右栏时**会话内容被左侧裁切**（`14-chat-right-panel.png`）——
这是 grid 列宽变化时内容宽度没有跟随的典型症状，属缺陷不是设计选择。

### 4.2 密度：行高与表格

数据表的通行档位（多篇企业级 UX 指南一致）：
紧凑 24–32px、标准 40–48px、舒适 48–56px；
在笔记本视口上能放 20–30 行的 32–36px 被反复推荐为默认
（<https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables>、
<https://medium.com/design-with-figma/the-ultimate-guide-to-designing-data-tables-7db29713a85a>、
<https://stephaniewalter.design/blog/essential-resources-design-complex-data-tables/>）。

- **冻结**：滚动时**同时冻结表头与第一列**是明确的最佳实践；窄屏用横向滚动 + 粘性第一列。
- **斑马纹 vs 行线**：斑马纹帮助跨行追踪（5–10% 灰即够），但与 hover/focus/selected/disabled 状态叠加后
  很难区分；**超过 20 行时更推荐 1px 低对比行线**。
  **【设计判断】证据矩阵用行线 + hover 高亮，不用斑马纹** —— 因为矩阵行需要"选中/已核验/待核"
  多个状态并存，斑马纹会把状态底色吃掉。
- **数字右对齐 + tabular-nums**，小数位统一。

### 4.3 加载：骨架、spinner 与"超过 10 秒"

Nielsen 的三个响应时间界限（原文）：
**0.1s** "the limit for having the user feel that the system is reacting instantaneously"；
**1.0s** "the limit for the user's flow of thought to stay uninterrupted"；
**10s** "the limit for keeping the user's attention focused on the dialogue. For longer delays,
users will want to perform other tasks while waiting…so they should be given feedback indicating
when the computer expects to be done."
（<https://www.nngroup.com/articles/response-times-3-important-limits/>）

NN/g 对三种指示器的划分：骨架屏只在**真实加载落在约 400ms–3s** 时改善感知，超出这个区间无效
（<https://www.nngroup.com/articles/skeleton-screens/>、
<https://www.nngroup.com/videos/skeleton-screens-vs-progress-bars-vs-spinners/>）。
常被引用的分档：<100ms 不显示；100–400ms 行内小 spinner；400ms–3s 骨架；>3s 骨架 + 进度与粗略预估。

**对 EviMed 的直接含义**（F6：导航到可用输入框 10.3–11.2 秒，期间只有一行灰字
「正在启动研究运行时...」）：
10 秒正好踩在 Nielsen 的第三条界限上 —— 这里**必须给出"预计何时完成"**，
而当前给的是一句无进展感的静态文本。最低成本修法：换成与最终布局同构的骨架
（左栏 + 中栏消息位 + 输入框轮廓）+ 一行带真实里程碑的状态（「已连接运行时 · 正在载入 15 项科研能力」）。

### 4.4 动效

Material 3 的时长/缓动 token（<https://m3.material.io/styles/motion/easing-and-duration/tokens-specs>）：
组件状态变化（按钮按下、chip 选中、图标切换）用 **150–200ms**；
容器变化（卡片展开、菜单打开）用 **250–300ms**；
标准缓动 `cubic-bezier(0.2, 0, 0, 1)`，减速 `cubic-bezier(0, 0, 0, 1)`，加速 `cubic-bezier(0.3, 0, 1, 1)`。

EviMed 现状：`index.css:136-146` 已有 `prefers-reduced-motion` 全局收敛，且注释明确
"Loading indicators keep their meaning — the spinner/pulse icon still renders, it just does not move"
—— 这条处理是对的，保留。缺的是**时长/缓动本身没有 token**，散在各组件。

### 4.5 长文阅读

一份 62KB 的证据报告需要：目录导轨（TOC rail，右侧或左侧细栏，当前章节高亮）、
阅读进度、可锚定的标题（`#anchor` + 复制链接）、以及**返回顶部**。
`深圳医保局/docs/DESIGN_GUIDELINES.md` 第 6 节已有一条同族规则
（长页用吸顶页内标签分区、提供回到顶部），可直接复用。

### 4.6 层次：边框优先于阴影

在"安静"的界面里，阴影是噪音源。Linear（近黑画布 + `hairline #23252a`）、
Notion（`hairline #e5e3df`）、Stripe（`hairline #e3e8ee`）都以**1px 发丝线**承担绝大部分层次，
阴影只留给真正浮起的层（菜单、弹出卡）。
EviMed 现状两档（`shadow-card` 静态 / `shadow-pop` 浮层）方向正确 ——
但 `shadow-card` 用在静态卡片上本身就是多余的一档，见第 9 节。

---

## 5. 针对现有缺陷的组件最佳实践

### 5.1 收件箱铃铛 + 徽标（现状最严重的一处）

现状（F7）：图标 14×14，徽标 14px 高 × 15.4px（一位数）/ ~22px（两位数），
定位 `-right-0.5 -top-0.5`，字号 12px/行高 18px，底色 `rgb(178,79,42)` —— **徽标把图标盖住了**。

- Material 3 规范：**小徽标 6dp（无数字）、大徽标 16dp（带数字）**
  （<https://m3.material.io/components/badges/specs>）。现状 14–22px 的徽标配 14px 图标，
  比例完全反了：徽标不应大于图标的一半。
- WCAG 2.2 SC 2.5.8：点击目标 ≥24×24 CSS px。14×14 的图标按钮**不合规**
  （<https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>）。

**规格**：图标 20×20，按钮命中区 32×32（内边距 6px），徽标用 **16px 圆角胶囊 / 8px 圆点**，
偏移到图标外沿（`top: -2px; right: -2px`），底色**不用品牌赭红**而用中性强调（见第 7 节 `--badge`），
两位数以上显示 `9+`。徽标必须带 `aria-label="未读通知 2 条"`。

### 5.2 15 项科研能力：不要 chips，也不要下拉

阈值共识：单选项 <6–7 项用单选/chips，多于此用列表框或下拉
（USWDS <7、Material M3 =6；<https://www.nngroup.com/articles/listbox-dropdown/>）。
**15 项两边都不适用**：chips 会占满一整屏且无法扫读，下拉会藏住 EviMed 最重要的资产。

现状（`05-capabilities.png`）是 15 张高卡片、每张带两字母字母组（SA/BA/CS/CE）+ 分类标签 + 时长 + 示例。
问题不在形式而在**密度与色**：每卡约 220px 高，一屏只能看 3–4 张；分类标签用了与主按钮同一支赭红。

**规格**（第 10 节展开）：改为**两列紧凑行**（每行 ≈ 76px：标题 + 一行说明 + 元信息），
顶部保留搜索与分类筛选（分类 ≤6 个用 chips，用中性色不用品牌色），
字母组换成**统一线性图标**或直接去掉（两字母组在中文界面里不承载信息）。

### 5.3 项目切换器

Linear / Vercel / Notion / Slack 的共同形态：
左上角一个**带当前项目名 + 折线箭头的按钮**，点击打开带搜索的列表，底部固定「新建/管理」。
EviMed 现状（`09-project-switcher.png` / F 记录）形态正确，缺三件：
**搜索框**（项目多了必然需要）、**重命名**（F 段记录：服务端根本没有 rename 路由，
`ProjectSwitcher.tsx` 只发 ASCII id，于是页面上是硬编码的 "Default Project"）、
**当前项目的状态点**（有无运行中任务）。

### 5.4 最近任务行

现状：侧栏 11 行完全一样的「临床证据深度分析」；旧运行没有 question 文本（F7）。
**规格**：行内容 = 状态点（4 个状态：运行中脉冲 / 完成 / 失败 / 已取消，
**必须带形状或图标差异，不能只靠颜色**）+ 问题首行（截断）+ 相对时间。
标题缺失时回退到能力名 + 日期，**永远不要连续渲染同名行**。

### 5.5 进度时间线卡片（长任务）

见第 6 节的结论：**不给百分比**。卡片内容 = 阶段名 + 当前步骤 + 已用时 + 已完成的可验证产物计数。

### 5.6 引文 chip + 证据悬浮卡

Perplexity 的做法：行内上标数字 `[1]`，**hover 打开来源预览**（快速缓动 + 轻背景模糊），
卡内带标题与站点图标便于扫读；点击进全文。双模式兼顾速度与彻底性
（<https://aiuxplayground.com/teardowns/perplexity/citations/>、
<https://www.shapeof.ai/patterns/citations>）。
NotebookLM 让每句话末尾的引用可 hover 到**原文段落**（<https://en.wikipedia.org/wiki/NotebookLM>）。

**EviMed 的差异化点**：我们不只有"来源"，还有**逐字引文绑定 + 核验结论**。
所以悬浮卡应当是三段式：① 引文原文（等宽或引用样式，可复制）；② 来源题录 + DOI/PMID（等宽）；
③ 核验结论（✓/⚠ + 一句话）。这正是仓库 `claim_verification` → `claimVerification` 已有的数据。

### 5.7 核验标记 ✓ / ⚠

**硬约束**：它不能长得像临床告警。
理由：告警疲劳（§1.2）+ 中文语境红绿反转（§1.3）+ WCAG 1.4.1（§1.4）。

**规格**：
- ✓ 已核验：**中性/低饱和**的对勾，与正文同色系的深墨绿（不是 `--ok` 的"成功绿"），
  尺寸与正文 x-height 齐平，**默认不占用彩色**；
- ⚠ 待核：**空心圆 + 问号**或"待核"二字的小胶囊，用 `--warn` 的**极浅底 + 深字**，
  绝不用实色块，绝不用红；
- 两者都必须有文字 `title` / 屏幕阅读器标签；
- 只有 `SAFETY —` 一类才允许动用 `--danger`。

### 5.8 Toast vs 收件箱

现状（`06-inbox.png`）：收件箱卡片里直接打印英文校验器原文
（"claims[52].claim numeric fact 6 is not present in its direct support…"）。
这既违 `深圳医保局/docs/DESIGN_GUIDELINES.md` 的硬规则 1（枚举/错误码必须经中文映射），
也违其第 6 节（内部标识不上界面）。
**分工**：toast 只承载"刚刚这次操作的结果"且可撤销；收件箱承载"需要你回来处理的事"，
条目必须是**中文一句话 + 一个主动作**，原始校验文本放进「技术详情」折叠。

### 5.9 破坏性确认

沿用仓库既有规范：ConfirmDialog 文案说明后果、初始焦点落「取消」、单条删除改为 toast + 撤销
（`docs/ui-ux-audit/02-前端设计规范建议.md` §9.3）。本次调研无新增。

---

## 6. AI 产品 2025–2026 的视觉惯例

### 6.1 "正在工作"：odometer，不是 fuel gauge

2026 年这一条已经形成明确共识。核心论点：
进度条四十年的信誉来自"已知工作量、诚实汇报"这个窄承诺；**代理无法做出这个承诺** ——
"Step 4 of 7 becomes step 4 of 19 becomes, occasionally, step 4 of 4"，
所以百分比在结构上就是未定义的，不是标定问题。把证据转成预测，等于重新引入你想逃离的那个谎
（<https://tianpan.co/blog/2026/07/02/why-you-cant-put-a-progress-bar-on-an-agent>）。

**该显示什么**（同源，四条）：
1. **可验证的里程碑** —— "读了 14 个文件、复现了缺陷、9 个测试过了 7 个"，不是百分比；
2. **实时活动流** —— 工具调用、当前文件、当前步骤的时间序日志；
3. **消耗计** —— 已用时、token、步数，**"odometer, not a fuel gauge"**；
4. **可见且会变的计划** —— 允许计划增长，并显示"因为发现了 X 所以加了一步"。

点名的反模式：把证据转成假预测（"60% done"）、与真实工作解耦的定时进度条、
与实际工作无关的轮播状态行、无工作证据的静默 spinner、**长时间静默打字的聊天气泡**。

并且：用户真正要的是**可中断与可操舵**（安全停止、中途纠偏、保留进度的检查点），不是百分比。

**对 EviMed 的直接含义**：现状恰好命中最后一个反模式 ——
父会话 26 分 53 秒里只显示「深度求索中... 26分53秒」（F4），
而子代理正在每分钟写文件。`16-chat-subagent-menu.png` 显示**内核原生的
「2 个子代理」菜单已经在工作**（每个子代理带 token、时长、运行中圆点）。
结论：**不需要发明进度 UI，需要把已有的子代理/计划/交付物面板放到主视线里**。

### 6.2 组件词汇已经标准化

shadcn/ui 2026-06 发布的聊天组件是当前最接近"事实标准"的一套命名
（<https://ui.shadcn.com/docs/changelog/2026-06-chat-components>）：

| 组件 | 职责 |
|---|---|
| `MessageScroller` | 会话滚动容器：锚定轮次、流式回复、线程恢复、历史前插、跳转、可见性追踪 |
| `Message` | 会话行：头像、对齐、header/content/footer、消息分组 |
| `Bubble` | 消息表面：变体、对齐、反应、链接、按钮、可折叠内容 |
| `Attachment` | 文件/图片：媒体、元信息、上传态、操作 |
| `Marker` | **状态更新、系统备注、带边框行、带标签分隔线** —— 用于流式状态、工具活动、日期分隔 |
| `scroll-fade`（CSS 工具） | 滚动容器边缘渐隐，提示还有内容 |
| `shimmer`（CSS 工具） | **"adds a text shimmer for live status"**，用于 "Thinking…"、"Generating response…" |

值得注意的是 **`Marker`**：工具调用行在 2026 的主流做法是**带标签的分隔线/系统行**，
而不是气泡、也不是卡片。EviMed 框架内现状（`13-chat-tool-row-clicked.png`：
`✦ 工具调用 · evimed_capsule_recall · 阿司匹林 一级预防…`）正是这个形态，**是对的，保留**。

### 6.3 shimmer 何时是高级的、何时是廉价的

shimmer 的正当用法是**文字微光表示"正在处理"**（区别于"被动等待"的 spinner），
且只用于**单行状态文字**（<https://ui.shadcn.com/docs/changelog/2026-06-chat-components>、
<https://www.patterns.dev/react/ai-ui-patterns/>）。

廉价的信号（**【设计判断】**，基于上述来源的反向推论 + 本次截图观察）：
- **彩色渐变的 shimmer**。EviMed 现状「深度求索中...」是**蓝色渐变文字**（F7），
  它同时做了三件不该做的事：引入第三套颜色、用渐变、且文案是内核的品牌词而非我们的。
  正确做法是**同色系的明度微光**（`--muted` → `--text` 之间摆动），无色相变化。
- 星星/闪光 emoji、紫粉渐变、发光边框、"AI 光晕"。严肃仪器不用这些。
- 反过来，**可以大方使用**的是：等宽的计数器（已用时、token、步数）、细分隔线、
  低饱和的状态点 —— 它们读作"仪表"，不是"特效"。

### 6.4 置信/来源标识是 2026 的新主模式

"visual confidence indicator —— 传达 AI 对输出的确定程度、或信息的来源"
被多篇 2026 的综述列为当年最重要的新模式
（<https://zylos.ai/research/2026-05-28-agentic-ux-frontend-design-patterns-ai-agents/>、
<https://www.shapeof.ai/patterns/citations>）。

EviMed 在这一点上**领先于模式而不是落后**：`claim` 已经有 direct/synthesized/derived 三类型、
逐条 ✓/⚠ 标记、引文绑定。问题纯粹是**视觉上没把它当作主角**。
第 10 节把它提到组件规格的第一梯队。

### 6.5 严肃专业仪器长什么样

把本节与 §1、§4.6 合起来，可以给出一组可检验的特征（**【设计判断】**，
但每条都能对应到前文的来源）：

1. **色少**：一支品牌色 + 一支中性阶 + 四支语义色，彩色总覆盖面积 <5% 屏幕。
2. **线多于影**：层次靠 1px 发丝线（Linear/Notion/Stripe 的共同做法，§4.6）。
3. **数字对齐**：tabular-nums、右对齐、单位分离（§3.6）。
4. **状态冗余编码**：颜色 + 图标 + 文字（§1.4）。
5. **过程可见但可折叠**：工具行用 `Marker` 形态，默认折叠，可展开（§6.2）。
6. **没有预测，只有证据**：odometer 而非百分比（§6.1）。
7. **动效克制**：150–300ms，无弹跳、无视差（§4.4）。
8. **排印承担分量**：标题层级与行宽做主要的视觉工作，而不是色块。

## 7. 交付物 A：EviMed Token 方案

> 所有色阶用 OKLCH 生成（L 序列固定、C 呈钟形并在 sRGB 内夹紧），hex 为夹紧后的实际值。
> 所有对比度用 WCAG 2.1 相对亮度公式实算（`node`，脚本逻辑见本节末）。

### 7.0 先说一个实测到的关键事实：框架的 token 模型与我们的是同构的

从 `docs/ui-ux-audit/2026-09-18-walk/chat.json` 里提取出框架暴露的 **358 个 `--dsw-*` 变量**，
它的结构是标准三层：

| 层 | 变量族 | 例 |
|---|---|---|
| primitive | `--dsw-static-{neutral,neutral-bluish,blue,deepseek,green,amber,red}-{NN}` | `--dsw-static-blue-500`、`--dsw-static-neutral-bluish-850` |
| semantic / alias | `--dsw-alias-*` | `bg-base`、`bg-layer-1..3`、`border-l1..l4`、`brand-primary`、`link`、`label-primary/secondary/tertiary/caption`、`button-primary-fill/hover`、`state-{error,warn,success}-{primary,secondary,tertiary}`、`markdown-citation`、`interactive-bg-hover`、`toast-bg`、`tooltip-bg` |
| component / specific | `--dsw-specific-*` | `bubble`、`bubble-highlight`、`input-major`、`menu`、`selector`、`sidebar-fill`、`sidebar-nav-item-active`、`tip` |
| 效果 | `--dsw-elevation-{soft,panel,prominent,stroke,stroke-color}`、`--dsw-shadow-lv1..3`、`--dsw-corner-shape`、`--dsw-mask-blur` | |
| 排印 | `--dsw-font-family`、`--dsw-font-{xxs-12,xs-13,s-14,base-16,m-18,l-20,xl-24}`（各带 `-font-size/-font-weight/-line-height/-font-family`）、整套 `--dsw-font-markdown-{h1..h4,base,small,code,code-block,table,table-head}` | |

**以及那个蓝色渐变的「深度求索中...」有自己的变量：`--dsw-linear-gradient-think` / `--dsw-linear-think-select`。**
也就是说它是可以直接被覆盖掉的，不需要改内核。

> ⚠️ 注意：本次抓取拿到的是**变量名清单，值为空串**（它们定义在非 `:root` 的作用域里，
> `getComputedStyle(:root)` 读不到）。落地时必须在真实会话里逐个验证覆盖是否生效
> （符合仓库「任何会话行为改动都要在真实 DSH + DeepSeek 会话上验证」的规则）。

**结论**：壳与框架可以共用同一份语义 token，只是名字不同。第 7.6 节给出一一对应表。

---

### 7.1 方向 A「循证青」Evidence Teal

**立意**：冷中性纸 + 深青绿。读作实验室仪器 / 检索工具，而不是聊天助手。
青绿在 NHS 调色板里在册（Aqua-green `#00a499`）、是 Elicit 的选择（`#083d44`），
且与 EviMed **现有的 favicon `#1f6f5c`（实测 OKLCH H=173.5）同族** ——
换句话说这不是引入新色，是把已经存在的品牌色扶正。

**品牌阶 `--brand-*`（OKLCH H=185）**

| 档 | hex | OKLCH |
|---|---|---|
| 50 | `#f0fbf9` | `oklch(98.0% 0.012 185)` |
| 100 | `#e1f7f3` | `oklch(95.8% 0.023 185)` |
| 200 | `#c3ece6` | `oklch(91.2% 0.044 185)` |
| 300 | `#98dbd2` | `oklch(84.5% 0.069 185)` |
| 400 | `#63c5b9` | `oklch(76.0% 0.094 185)` |
| 500 | `#26ac9f` | `oklch(67.2% 0.110 185)` |
| 600 | `#008f84` | `oklch(58.5% 0.103 185)` |
| 700 | `#00756b` | `oklch(50.5% 0.089 185)` ← 浅色主色 |
| 800 | `#005e56` | `oklch(43.2% 0.076 185)` |
| 900 | `#004841` | `oklch(36.0% 0.064 185)` |
| 950 | `#002d29` | `oklch(26.8% 0.047 185)` |

**中性阶 `--n-*`（OKLCH H=232，C≤0.010 —— 冷中性）**

| 档 | hex | 档 | hex |
|---|---|---|---|
| 50 | `#f8f8f9` | 600 | `#767d81` |
| 100 | `#f0f1f2` | 700 | `#606669` |
| 200 | `#dfe2e4` | 800 | `#4c5154` |
| 300 | `#c8cdcf` | 900 | `#3a3e40` |
| 400 | `#acb2b5` | 950 | `#242628` |
| 500 | `#90979b` | | |

暗色专用面（同 H，更低 L）：
`bg #14181a` (20.5%) · `surface #1d2225` (24.8%) · `surface-2 #272d30` (29.2%) ·
`border-faint #292f32` (30.0%) · `border #3a4044` (36.8%) · `border-strong #646c71` (≈53%)。

**为什么中性是冷的**：暖中性（现状 H≈90）会把青绿品牌色推向"泥"，且暖底降低密集数字与表格的锐度；
NHS Grey-5 `#f0f4f5`、Stripe `#f6f9fc`、Notion `#f6f5f4` 都在冷/零色相一侧。
C 压到 0.010 以内，保证它读作"纸"而不是"蓝纸"。**【设计判断，参照上述三套系统的实测取值】**

---

### 7.2 方向 B「学刊墨」Scholarly Navy

**立意**：保留暖纸（现状资产，长文阅读友好），把赭红换成**深墨蓝**，
让"链接蓝 = 品牌蓝"合并成一支，✓ 用深绿。读作学术期刊 / 专著。
迁移面积最小：`--bg / --surface / --surface-2 / --text` 基本不动。

**品牌阶 `--brand-*`（OKLCH H=256）**

| 档 | hex | OKLCH | 档 | hex | OKLCH |
|---|---|---|---|---|---|
| 50 | `#f4f9ff` | `98.0% 0.010 256` | 600 | `#387cd2` | `58.5% 0.150 256` |
| 100 | `#e9f2ff` | `95.8% 0.020 256` | 700 | `#2564b3` | `50.5% 0.141 256` ← 浅色主色 |
| 200 | `#d0e4ff` | `91.2% 0.043 256` | 800 | `#1a4f92` | `43.2% 0.123 256` |
| 300 | `#abcfff` | `84.5% 0.078 256` | 900 | `#123c71` | `36.0% 0.102 256` |
| 400 | `#7cb4fe` | `76.0% 0.123 256` | 950 | `#092549` | `26.8% 0.075 256` |
| 500 | `#5697ec` | `67.2% 0.144 256` | | | |

**中性阶 `--n-*`（OKLCH H=85，C≤0.009 —— 暖中性，比现状更克制）**

| 档 | hex | 档 | hex |
|---|---|---|---|
| 50 | `#f9f8f8` | 600 | `#7e7b76` |
| 100 | `#f2f1f0` | 700 | `#67645f` |
| 200 | `#e3e2df` | 800 | `#52504c` |
| 300 | `#ceccc8` | 900 | `#3f3d3a` |
| 400 | `#b3b1ac` | 950 | `#272623` |
| 500 | `#989590` | | |

暗色面（H=265）：`bg #15171c` · `surface #1f2127` · `surface-2 #292c32` ·
`border-faint #2b2e34` · `border #3c3f46` · `border-strong #676b72`。

---

### 7.3 两方向共用的语义阶

| 语义 | H | 50 | 300 | 600 | 700 | 800 |
|---|---|---|---|---|---|---|
| `--danger-*` 危险 | 27 | `#fff6f5` | `#ffb7ae` | `#cf463e` | `#af302b` | `#8f2320` |
| `--warn-*` 警告 | 70 | `#fff7ef` | `#efc392` | `#ab6c00` | `#8c5700` | `#704500` |
| `--ok-*` 成功 | 150 | `#f3fbf4` | `#aadbb3` | `#3a9052` | `#25773e` | `#1a5f30` |
| `--info-*` 信息/链接 | 255 | `#f4f9ff` | `#aacfff` | `#1f7ae0` | `#0362bf` | `#004e9c` |

（完整 11 档可由同一 L/C 序列重算；上表列出实际会用到的档。）

**方向 A 用 `--info-*` 做链接**（链接蓝与品牌青分工清晰）；
**方向 B 的链接 = 品牌阶本身**（少一支颜色）。

---

### 7.4 语义层：浅色 / 深色

**方向 A**

| Token | 浅色 | 来源档 | 深色 | 来源档 |
|---|---|---|---|---|
| `--bg` | `#f8f8f9` | n-50 | `#14181a` | n-dark-bg |
| `--surface` | `#ffffff` | 纯白 | `#1d2225` | n-dark-surface |
| `--surface-2` | `#f0f1f2` | n-100 | `#272d30` | n-dark-s2 |
| `--border-faint` | `#e9ebed` | n-150 | `#292f32` | — |
| `--border` | `#dfe2e4` | n-200 | `#3a4044` | — |
| **`--border-strong`**（新） | `#8e969b` | — | `#646c71` | — |
| `--text` | `#242628` | n-950 | `#f0f1f2` | n-100 |
| `--muted` | `#606669` | n-700 | `#acb2b5` | n-400 |
| `--accent` | `#00756b` | brand-700 | `#63c5b9` | brand-400 |
| `--accent-fg` | `#ffffff` | — | `#14181a` | dark bg |
| `--accent-soft`（新） | `#f0fbf9` | brand-50 | `#004841` | brand-900 |
| `--link` | `#0362bf` | info-700 | `#aacfff` | info-300 |
| `--ok` | `#25773e` | ok-700 | `#aadbb3` | ok-300 |
| `--warn` | `#8c5700` | warn-700 | `#efc392` | warn-300 |
| `--error` / `--danger` | `#af302b` | danger-700 | `#ffb7ae` | danger-300 |
| `--error-fg` | `#ffffff` | — | `#14181a` | — |
| **`--verify-ok`**（新） | `#00756b` | brand-700 | `#98dbd2` | brand-300 |
| **`--verify-pending`**（新） | `#704500` | warn-800 | `#efc392` | warn-300 |
| **`--focus`**（新） | `#00756b` | brand-700 | `#63c5b9` | brand-400 |
| **`--badge`**（新） | `#af302b` | danger-700 | `#cf463e` | danger-600 |

**方向 B**：同结构，`--accent` = `#2564b3` / `#7cb4fe`，`--link` = `--accent`，
`--verify-ok` = `#25773e` / `#aadbb3`，中性换成暖阶，暗色面换 H=265 那组。

**`--badge` 为什么用 danger 而不是品牌色**：徽标的唯一职责是"有未处理的东西"，
它必须与"可点的主按钮"在颜色上分开（§1.2 红色预算：红只用于**需要人处理**的东西，
而未读计数正属于这一类；主按钮不是）。这样红的总覆盖面积依然极小（一个 16px 胶囊）。
**【设计判断】**

---

### 7.5 实算对比度（`node`，WCAG 2.1 相对亮度）

**方向 A · 浅色**

| 组合 | 前景 on 背景 | 实测 | 要求 | 结论 |
|---|---|---|---|---|
| 正文 / bg | `#242628` on `#f8f8f9` | **14.31:1** | 4.5 | PASS |
| 正文 / surface | `#242628` on `#ffffff` | **15.19:1** | 4.5 | PASS |
| 正文 / surface-2 | `#242628` on `#f0f1f2` | **13.43:1** | 4.5 | PASS |
| 辅助 / bg | `#606669` on `#f8f8f9` | **5.49:1** | 4.5 | PASS |
| 辅助 / surface | `#606669` on `#ffffff` | **5.83:1** | 4.5 | PASS |
| 辅助 / surface-2 | `#606669` on `#f0f1f2` | **5.16:1** | 4.5 | PASS |
| 强调字 / surface | `#00756b` on `#ffffff` | **5.59:1** | 4.5 | PASS |
| 主按钮文字 | `#ffffff` on `#00756b` | **5.59:1** | 4.5 | PASS |
| 链接 / surface | `#0362bf` on `#ffffff` | **5.99:1** | 4.5 | PASS |
| 警告 / surface | `#8c5700` on `#ffffff` | **6.04:1** | 4.5 | PASS |
| 危险 / surface | `#af302b` on `#ffffff` | **6.40:1** | 4.5 | PASS |
| 控件边框 / surface | `#8e969b` on `#ffffff` | **3.01:1** | 3.0 | PASS |
| 焦点环 / bg | `#00756b` on `#f8f8f9` | **5.27:1** | 3.0 | PASS |
| ✓ 胶囊 | `#005e56` on `#f0fbf9` | **7.26:1** | 4.5 | PASS |
| ⚠ 胶囊 | `#704500` on `#fff7ef` | **7.80:1** | 4.5 | PASS |
| SAFETY 胶囊 | `#8f2320` on `#fff6f5` | **8.13:1** | 4.5 | PASS |

**方向 A · 深色**

| 组合 | 实测 | 结论 |
|---|---|---|
| 正文 `#f0f1f2` / bg `#14181a` | **15.80:1** | PASS |
| 正文 `#f0f1f2` / surface `#1d2225` | **14.20:1** | PASS |
| 辅助 `#acb2b5` / surface | **7.49:1** | PASS |
| 强调 `#63c5b9` / surface | **7.81:1** | PASS |
| 主按钮文字 `#14181a` / `#63c5b9` | **8.69:1** | PASS |
| 链接 `#aacfff` / surface | **10.00:1** | PASS |
| ✓ `#98dbd2` / surface | **10.25:1** | PASS |
| ⚠ `#efc392` / surface | **9.86:1** | PASS |
| 危险 `#ffb7ae` / surface | **9.66:1** | PASS |
| 控件边框 `#646c71` / surface | **3.00:1** | PASS |

**方向 B · 浅色**（节选）：正文 14.27 · 辅助 5.56 · 品牌=链接 `#2564b3`/白 **5.91** ·
主按钮白字 5.91 · ✓ `#25773e`/白 5.55 · 警告 6.04 · 危险 6.40 —— 全部 PASS。
**方向 B · 深色**：正文 15.89 · 辅助 7.51 · 强调 `#7cb4fe` 7.52 · 主按钮 8.38 · 链接 10.04 —— 全部 PASS。

**状态点（图形对象，1.4.11 需 ≥3:1）**

| 点 | 浅色 | 实测 | 深色 | 实测 |
|---|---|---|---|---|
| 运行中 | `#1f7ae0` info-600 | 4.27:1 | `#79b4ff` info-400 | 7.48:1 |
| 已完成 | `#008f84` brand-600 | 3.99:1 | `#63c5b9` brand-400 | 7.81:1 |
| 失败 | `#cf463e` danger-600 | 4.57:1 | `#ff8b7f` danger-400 | 7.07:1 |
| 已取消 | `#767d81` **n-600** | 4.18:1 | `#90979b` n-500 | 5.42:1 |

> n-500 `#90979b` 在白底只有 **2.96:1（FAIL）** —— 浅色的"已取消"必须用 n-600，这是实算发现的坑。

**现状复核（同一算法）**

| 现有组合 | 实测 | 结论 |
|---|---|---|
| `--muted #6f6a61` / `--bg #f7f5ef` | 4.93:1 | PASS，但**无余量** |
| `--accent #b24f2a` / `--bg #f7f5ef` | 4.76:1 | PASS，无余量 |
| `--warn #96620f` / `--surface-2 #f2efe7` | **4.51:1** | 擦边 |
| `--ok #40784e` / `--surface-2 #f2efe7` | **4.55:1** | 擦边 |
| **框架 送信按钮白字 / `#4176e6`** | **4.23:1** | **FAIL（低于 AA 4.5:1）** |
| 框架 用户气泡 `#edf3fe` 上正文 | 13.34:1 | PASS |

**两条结论**：
1. 现有浅色 token 是一组"刚好压线"的值（4.51–4.93），任何一次色值微调都会掉下去；
   新方案的同类组合在 5.16–6.40，有 0.7–1.9 的余量。
2. **框架的送信按钮今天不合规**（4.23:1）。这不是意见，是实算。

---

### 7.6 映射表：现有 token 名 + 框架角色 → 新值

**壳（`OpenScience/apps/web/src/index.css`）**

| 现有变量 | 现值（浅/深） | → 方向 A（浅/深） | 说明 |
|---|---|---|---|
| `--bg` | `#f7f5ef` / `#16151a` | `#f8f8f9` / `#14181a` | 暖米 → 冷纸 |
| `--surface` | `#ffffff` / `#1e1d24` | `#ffffff` / `#1d2225` | 深色由紫调 H292 → 冷调 H232 |
| `--surface-2` | `#f2efe7` / `#26252d` | `#f0f1f2` / `#272d30` | |
| `--border-faint` | `#efece5` / `#25242b` | `#e9ebed` / `#292f32` | |
| `--border` | `#e7e3da` / `#33313c` | `#dfe2e4` / `#3a4044` | 仅装饰分隔 |
| **（新）`--border-strong`** | — | `#8e969b` / `#646c71` | **控件边界必须用它**（1.4.11） |
| `--text` | `#2a2723` / `#ece9e2` | `#242628` / `#f0f1f2` | |
| `--muted` | `#6f6a61` / `#9a958c` | `#606669` / `#acb2b5` | 余量 4.93 → 5.49 |
| `--accent` | `#b24f2a` / `#d0764f` | `#00756b` / `#63c5b9` | 赭红 → 深青 |
| `--accent-fg` | `#ffffff` / `#16151a` | `#ffffff` / `#14181a` | 不变语义 |
| **（新）`--accent-soft`** | — | `#f0fbf9` / `#004841` | 选中/hover 软底 |
| `--link` | `#2869d0` / `#7aa5f0` | `#0362bf` / `#aacfff` | |
| `--ok` | `#40784e` / `#6bb07d` | `#25773e` / `#aadbb3` | |
| `--warn` | `#96620f` / `#d7a24a` | `#8c5700` / `#efc392` | |
| `--error` | `#b44c41` / `#d47a70` | `#af302b` / `#ffb7ae` | 建议同时加别名 `--danger` |
| `--error-fg` | `#ffffff` / `#16151a` | 不变 | |
| **（新）`--verify-ok`** | — | `#00756b` / `#98dbd2` | ✓ 已核验 |
| **（新）`--verify-pending`** | — | `#704500` / `#efc392` | ⚠ 待核（**永不用红**） |
| **（新）`--focus`** | 现直接用 `--accent` | `#00756b` / `#63c5b9` | 独立命名，便于单独调 |
| **（新）`--badge`** | 现直接用 `--accent` | `#af302b` / `#cf463e` | 未读计数 |
| `--series-1..8` / `--chart-*` | 现值 | **保持不变** | 与 `@ai4s/shared` + matplotlib 三方同源，改动需跑 dataviz 校验；仅把 `--chart-grid/axis` 重绑到新的 `--border` / `--border-strong` |

**框架（iframe `--dsw-*`）**

| 框架角色 | 变量（实测名） | 现状 | → 方向 A |
|---|---|---|---|
| 送信按钮底 | `--dsw-alias-button-primary-fill` | `rgb(65,118,230)`（白字 **4.23:1 FAIL**） | `#00756b`（白字 5.59:1） |
| 送信按钮 hover | `--dsw-alias-button-primary-hover` | — | `#005e56` |
| 品牌色 | `--dsw-alias-brand-primary` / `-invert` / `brand-text` | 上游蓝 | `#00756b` / `#ffffff` / `#00756b` |
| 用户气泡底 | `--dsw-specific-bubble` | `rgb(237,243,254)` | `#f0f1f2`（n-100，中性）**或** `#f0fbf9`（brand-50） |
| 气泡高亮 | `--dsw-specific-bubble-highlight` | — | `#e1f7f3` brand-100 |
| 链接 | `--dsw-alias-link` | 上游蓝 | `#0362bf` |
| 引文标记 | `--dsw-alias-markdown-citation` | 上游蓝 | `#00756b` |
| **「深度求索中」渐变** | `--dsw-linear-gradient-think`、`--dsw-linear-think-select` | **蓝色渐变** | `linear-gradient(90deg, #606669, #242628, #606669)` —— **同色系明度微光，无色相** |
| 画布/层 | `--dsw-alias-bg-base` / `bg-layer-1..3` | 白 | `#ffffff` / `#f8f8f9` / `#f0f1f2` / `#e9ebed` |
| 文字 | `--dsw-alias-label-primary` / `-secondary` / `-tertiary` / `-caption` | — | `#242628` / `#606669` / `#767d81` / `#767d81` |
| 边框 | `--dsw-alias-border-l1..l4` | — | `#e9ebed` / `#dfe2e4` / `#c8cdcf` / `#8e969b` |
| 状态 | `--dsw-alias-state-{error,warn,success}-primary` | — | `#af302b` / `#8c5700` / `#25773e` |
| 选区 | `--dsw-alias-bg-multi-select`、`--dsw-alias-interactive-bg-hover-accent` | — | `#e1f7f3` brand-100 |
| 侧栏 | `--dsw-specific-sidebar-fill`、`-nav-item-active`、`-hover` | — | `#f8f8f9` / `#e1f7f3` / `#f0f1f2` |
| 输入框 | `--dsw-specific-input-major` | — | 底 `#ffffff`，边 `#8e969b`，聚焦边 `#00756b` |
| 圆角 | `--dsw-corner-shape` | — | 与壳的 `--radius-card` 对齐（见 §9） |
| 阴影 | `--dsw-shadow-lv1..3`、`--dsw-elevation-*` | — | 与壳的 `--shadow-pop` 对齐，`lv1` 置为 `none` |
| 字体 | `--dsw-font-family` | `-apple-system, …, "PingFang SC"` | 与壳统一（§8） |
| 正文字号 | `--dsw-font-markdown-base-*` | 16px | 16px / 1.75（§8），仅改行高 |

---

### 7.7 推荐：方向 A「循证青」

理由，按权重排序：

1. **现状的暖米 + 赭红在色相、明度与用法上与 Claude 官方 DESIGN.md 同构**（§前置）。
   一个要卖"医学可信度"的临床工具，外观撞上一个通用聊天助手的品牌色，是识别度与定位的双重损失。
   方向 B 保留暖纸，**缓解不了这一条**。
2. **红色预算**（§1.2）。方向 A 把主色移出暖红区，红从此只做危险与未读；
   方向 B 的深蓝同样做到，但 B 的"链接=品牌"合并会让**引文链接与主按钮同色** ——
   对一个满屏都是引文链接的产品，这会让主按钮淹没。
3. **favicon `#1f6f5c` 已经是这支色**（实测 OKLCH H=173.5）。方向 A 让三套色系收敛到**已有的**品牌资产上，
   而不是引入第四套。
4. **中文语境安全**（§1.3）：品牌青绿不承担"通过/失败"语义；✓ 核验用品牌色本身，
   正好把产品的核心承诺（可核验）与品牌绑在一起，且 ⚠ 用琥珀而非红，与临床告警彻底分开。
5. **与框架的收敛成本一样低**：两个方向都要覆盖同一批 `--dsw-*` 变量，工作量相同。
6. **对比度余量更大**：A 的青绿在 sRGB 里色度受限（700 档 C 被夹到 0.089），
   意味着它天然"低饱和"，不会像高饱和蓝那样在大面积使用时刺眼。

**方向 B 的保留价值**：若迁移预算是硬约束（暖纸底涉及大量截图、报告模板、图表底色），
B 是一个可在两天内落地的版本，且本身自洽。但它解决的是合规与统一，解决不了**识别度**。

**不推荐的第三条路**：保留赭红只是把它"限制在小范围"。
实算已经显示现有赭红在 `--bg` 上只有 4.76:1（无余量），且它同时是主按钮、分类标签与未读徽标 ——
限制用法需要改的地方，与换色一样多。

**迁移顺序**（最小可验证步骤）：
① 先加 primitive 阶与 `--border-strong` / `--focus` / `--badge` / `--verify-*`，不动任何现有值（零风险）；
② 覆盖框架 `--dsw-*`（修掉 4.23:1 的不合规，并杀掉蓝渐变），在真实会话里验证；
③ 切换壳的 `--accent` 族；
④ 切换中性阶（`--bg/--surface/--text/--muted`），同时验证 25+ 处截图与报告模板；
⑤ 图表色最后处理，必须跑 dataviz 校验。

---

## 8. 交付物 B：字号 / 字体栈 / 行高 / 行宽

### 8.1 字体栈（壳与框架用同一份）

```css
--font-sans:
  Inter, "SF Pro Text", system-ui,
  "PingFang SC", "HarmonyOS Sans SC", "MiSans",
  "Hiragino Sans GB", "Microsoft YaHei",
  "Noto Sans CJK SC", "Source Han Sans SC", sans-serif;

--font-serif:                    /* 仅标题与报告封面，不进正文 */
  "Source Serif 4", Georgia,
  "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif;

--font-mono:                     /* DOI / PMID / NCT / id / 代码 */
  "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas,
  "Noto Sans Mono CJK SC", monospace;
```

变动点（相对现状）：
- 新增 **`HarmonyOS Sans SC`、`MiSans`** —— 覆盖鸿蒙与 MIUI 设备，两者均免费商用（§3.1）。
- 拉丁面保持在前（数字、DOI、标识符的度量不变）。
- **`--font-serif` 不含 `SimSun`** —— 现状 `tailwind.config.js:28` 末尾挂着 `SimSun`，
  等于在 Windows 上主动选择点阵宋体。删掉它，让它落到 `serif` 由系统决定，或干脆只在标题用。

### 8.2 混排规则（全局，一次写对）

```css
:root { font-synthesis-weight: none; }        /* 中文不合成伪粗体 */

body, .prose {
  /* 三家浏览器都把初始值实现成 no-autospace，必须显式写 —— §3.5 */
  text-autospace: ideograph-alpha ideograph-numeric;
  /* 仅 Chromium 支持，渐进增强 */
  text-spacing-trim: normal;
}

.prose { text-wrap: pretty; }                  /* 避免孤字行尾 */
.tabular { font-variant-numeric: tabular-nums; }
```

**禁止**：给中文加 `letter-spacing`；给中文用 `font-weight: 500`（§3.7）。
**字重只有两档：400 / 600。**

### 8.3 字号刻度（六档，去掉半像素）

| Token | 字号 / 行高 | 计算行高 | 用途 |
|---|---|---|---|
| `text-caption` | 12px / 1.5 | 18px | 徽标、时间戳、元信息 |
| `text-ui-sm` | 13px / 1.55 | 20px | 次级按钮、chip、辅助行 |
| `text-ui` | **14px / 1.6** | **22.4px** | 默认 UI 文字、列表行、表格单元 |
| `text-body` | **16px / 1.75** | **28px** | 对话正文、报告正文 |
| `text-title` | 20px / 1.35 | 27px | 页面标题（serif 或 sans 均可） |
| `text-display` | 26px / 1.25 | 32.5px | 品牌级标题、空态 |

变动点：
- **`ui` 从 13.5px → 14px**：消灭半像素；且 14/22 正是 Ant Design 与 TDesign 共同落点（§3.3）。
- **`ui-sm` 与 `ui` 现在真的差 1px**（此前 13 / 13.5 是同一档伪装成两档）。
- **`body` 从 15px → 16px**：与框架实测的 16px 对齐，壳与框架不再有两种正文字号（§3.4）。
- 行高全部上调（中文需要更多行距）：`ui` 1.55→1.6，`body` 1.65→1.75。

对应到框架：`--dsw-font-xxs-12` ↔ caption、`--dsw-font-xs-13` ↔ ui-sm、
`--dsw-font-s-14` ↔ ui、`--dsw-font-base-16` ↔ body、`--dsw-font-m-18`/`l-20` ↔ title、
`--dsw-font-xl-24` ↔ display。**框架的刻度与我们的六档天然一一对应，只需改行高。**

### 8.4 报告长文的排印（`.prose`）

| 项 | 值 | 依据 |
|---|---|---|
| 正文 | 16px / 1.8 | CJK 长文行高上限（§3.3） |
| 段间距 | `0.9em`（≈14.4px） | 段距 > 行距，才能读出段落 |
| 行宽 | **`max-width: 680px`**（≈42 中文字/行） | 中文 35–45 字（§3.4） |
| h1 | 26px / 1.3，serif，`margin-top: 0` | |
| h2 | 20px / 1.4，600，`margin-top: 2em` | |
| h3 | 17px / 1.5，600，`margin-top: 1.6em` | |
| h4 | 16px / 1.6，600 | |
| 表格 | 14px / 1.5，`tabular-nums`，右对齐数字 | §4.2 |
| 代码/标识符 | 13.5px mono，`--surface-2` 底 | §3.6 |
| 引用块 | 左 3px `--border-strong` 边，`--muted` 字 | |

### 8.5 容器宽度（四档，收窄）

| Token | 现值 | 建议 | 用途 |
|---|---|---|---|
| `content-narrow` | 672px | 640px | 设置 / 表单 |
| `content` | **760px** | **680px** | **对话流与报告正文**（42 字/行） |
| `content-wide` | 1024px | 1000px | 运行记录、笔记本 |
| `content-full` | 1080px | 1120px | 证据矩阵、能力目录（表格需要宽度） |

### 8.6 三栏尺寸

| 区域 | 建议 | 现状 |
|---|---|---|
| 左栏 | 264px（可拖 240–320，可折叠到 56px 图标栏） | 280px 固定 |
| 中栏 | 最小 640px，正文限宽 680px | 680px（1440 下） |
| 右栏 | 默认 **360px**，可拖 320–480；`< 1280px` 改为覆盖层 | **528px（比中栏还宽 —— 应修）** |
| 390px 断点 | 左栏抽屉、右栏全屏覆盖、正文 `padding: 0 16px` | 需验证 |

---

## 9. 交付物 C：间距 / 圆角 / 阴影 / 动效 Token

### 9.1 间距（4px 基准，八档）

```
--space-0:0  --space-1:4px  --space-2:8px  --space-3:12px
--space-4:16px --space-5:24px --space-6:32px --space-7:48px --space-8:64px
```

密度规则（**【设计判断】**，与 §4.2 的行高档位一致）：
- 列表行、表格行内边距：`--space-2 --space-3`（8/12），行高 **36px**（紧凑）或 **44px**（标准）
- 卡片内边距：`--space-4`（16）小卡 / `--space-5`（24）内容卡
- 区块间距：`--space-5`（24）同组 / `--space-6`（32）跨组
- 页面上下留白：`--space-6`（32），不要用 96px 的营销页节奏

### 9.2 圆角（四档）

```
--radius-chip:  999px   /* 胶囊、状态标签、徽标 */
--radius-input: 8px     /* 输入、按钮、小控件（现 10px → 8px） */
--radius-card:  12px    /* 卡片、面板（现 14px → 12px） */
--radius-panel: 16px    /* 抽屉、模态、浮层 */
```
理由：Claude DESIGN.md 的层级是 8 / 12 / 16 / pill；12px 卡片比 14px 更"仪器"，
14px 偏"消费级"。**【设计判断，参照实测的四份 DESIGN.md 圆角层级】**
框架侧用 `--dsw-corner-shape` 对齐。

### 9.3 阴影（两档 + 一条线）

```
--shadow-none: none;                                    /* 静态卡片：只用 1px 边框 */
--shadow-pop:  0 4px 16px rgba(20,24,26,.10), 0 1px 3px rgba(20,24,26,.06);   /* 菜单/弹出 */
--shadow-modal:0 16px 48px rgba(20,24,26,.18), 0 2px 8px rgba(20,24,26,.08);  /* 模态/抽屉 */
```
**取消现有的 `shadow-card`**：静态卡片改用 `1px solid var(--border)`（§4.6，
Linear / Notion / Stripe 一致做法）。深色下阴影不可见，层次全靠 `--surface` 逐层提亮
（Carbon layering model）。

### 9.4 动效

```
--dur-instant: 100ms   /* 颜色、透明度 */
--dur-fast:    160ms   /* 按钮按下、chip 选中、图标切换 */
--dur-base:    240ms   /* 卡片展开、菜单打开、面板切换 */
--dur-slow:    320ms   /* 抽屉、右栏滑入 */
--ease-standard:   cubic-bezier(0.2, 0, 0, 1);
--ease-decelerate: cubic-bezier(0, 0, 0, 1);
--ease-accelerate: cubic-bezier(0.3, 0, 1, 1);
```
取值对齐 Material 3 的时长/缓动规范（§4.4）。
规则：**没有弹跳（overshoot）、没有视差、没有超过 320ms 的动画**；
`prefers-reduced-motion` 已有的全局收敛保留不动（`index.css:136-146`）。

### 9.5 层级（z-index）

```
--z-base:0  --z-sticky:10  --z-overlay:40  --z-drawer:40
--z-modal:50  --z-popover:60  --z-toast:70
```
（沿用 `docs/ui-ux-audit/02-前端设计规范建议.md` §4 已提出的刻度，本次调研无异议。）

### 9.6 焦点环

```css
:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
  border-radius: inherit;
}
```
2px 厚度 + 3:1 对比 = 满足 WCAG 2.4.13 的两个量化条件（§2.5）。
现状已经是这个形状（`index.css:122-131`），只需把 `--accent` 换成独立的 `--focus`，
并**补一条**：吸顶的横幅/输入框必须为焦点元素留出滚动余量，否则违 **2.4.11（AA）**。

## 10. 交付物 D：组件规格

> 全部按方向 A 的 token 写。状态一律「默认 / hover / active / focus-visible / disabled / loading」六态齐备。

### 10.1 收件箱铃铛 + 未读徽标

| 项 | 规格 |
|---|---|
| 命中区 | **32 × 32 px**（WCAG 2.5.8 要求 ≥24×24；32 给触摸留量） |
| 图标 | lucide `bell`，**20 × 20**，`stroke-width: 1.75`，色 `--muted`；hover 转 `--text` |
| 按钮底 | 透明；hover `--surface-2`，`--radius-input` |
| 徽标（有数字） | 高 **16px**，最小宽 16px，横向内边距 4px，`--radius-chip`，底 `--badge`，字 `#ffffff` 11px/16px 600 `tabular-nums` |
| 徽标（无数字） | **8 × 8 px 圆点**，底 `--badge`，描边 2px `--bg`（与底分离） |
| 定位 | `top: -2px; right: -2px`，**必须在图标外沿**，不得遮挡图标 |
| 溢出 | `> 99` 显示 `99+`；`> 9` 显示两位 |
| 无障碍 | 按钮 `aria-label="通知，未读 {n} 条"`；数字区 `aria-hidden`；未读变化 `aria-live="polite"` |
| 空态 | 0 条时**不渲染徽标**，图标保持 `--muted` |

依据：Material 3 徽标 6dp（无标签）/ 16dp（带标签）（§5.1）；WCAG 2.5.8（§2.5）。
**现状对照**：图标 14×14、徽标 14–22px 压在图标上、用品牌赭红 —— 三项全改。

### 10.2 项目切换器

| 项 | 规格 |
|---|---|
| 触发按钮 | 宽 `100%`（左栏内减 2×16 内边距），高 **40px**，`--radius-input`，底 `--surface`，边 `1px --border` |
| 内容 | 16×16 项目图标 + 项目名（`text-ui`，单行截断）+ 右侧 `chevrons-up-down` 14×14 `--muted` |
| 运行中指示 | 项目名左侧 6px 圆点 `--info-600`，`animate-pulse`（reduced-motion 下静止） |
| 展开面板 | 宽 = 触发宽或 280px（取大），`--shadow-pop`，`--radius-card`，最多 8 行后滚动 |
| 面板头 | **搜索框**（`text-ui`，占位「搜索项目」），> 6 个项目时出现 |
| 行 | 高 36px，hover `--surface-2`，当前项左侧 2px `--accent` 竖条 + 勾选图标 |
| 面板尾 | 固定「新建项目」（`--accent` 文字按钮）+「管理项目」 |
| 键盘 | ↑↓ 移动、Enter 选中、Esc 关闭并还焦、输入即过滤 |
| 缺口 | **重命名**：服务端无 rename 路由（`server.mjs:3032-3081` 只有 GET/POST/DELETE/export），POST 接受 `name` ≤128 但前端只发 ASCII id —— 需要后端配合，否则页面上永远是 `Default Project` |

### 10.3 最近任务行

| 项 | 规格 |
|---|---|
| 行高 | **44px**（两行文本时 56px），内边距 `8px 12px`，`--radius-input` |
| 状态指示 | **左侧 8×8 图形**，四态各不相同的**形状 + 颜色**：运行中 = 脉冲圆点 `--info-600`；已完成 = 实心圆 `--brand-600`；失败 = 实心方块 `--danger-600`；已取消 = 空心圆 `--n-600` |
| 第一行 | 问题文本（`text-ui`，`line-clamp: 1`）；无问题时回退「{能力名} · {日期}」 |
| 第二行（可选） | `text-caption --muted`：能力名 · 相对时间 |
| hover | 底 `--surface-2`；右侧出现「更多」图标按钮（`opacity-0 group-hover:opacity-100 group-focus-within:opacity-100`） |
| 当前选中 | 底 `--accent-soft`，左侧 2px `--accent` 竖条 |
| 硬规则 | **不允许连续渲染同名行** —— 同名时必须补日期或问题片段区分（现状 11 行「临床证据深度分析」） |

### 10.4 科研能力启动器

| 项 | 规格 |
|---|---|
| 布局 | ≥1200px 两列；768–1200 单列；<768 单列窄 |
| 行 | 高 **76px**，内边距 `16px`，`--radius-card`，边 `1px --border`，底 `--surface`；hover 边 `--border-strong` + 底 `--surface-2` |
| 图标 | 20×20 lucide 线性图标，色 `--muted`（**取消两字母字母组** —— 在中文界面里不承载信息） |
| 标题 | `text-ui` 600 `--text` |
| 说明 | `text-ui-sm --muted`，`line-clamp: 1` |
| 元信息 | `text-caption --muted`：`⏱ 约 30–120 分钟` · `📚 支持知识库资料`（图标 12×12） |
| 分类标签 | `text-caption`，`--radius-chip`，底 `--surface-2`，字 `--muted` —— **中性，不用品牌色**（现状用赭红，与主按钮抢注意力） |
| 顶部筛选 | 搜索框 + 分类 chips（≤6 个，第 7 个起并入「更多」下拉，依据 §5.2 的 6–7 阈值） |
| 示例句 | 移入 hover 提示或详情抽屉，不占列表行 |

### 10.5 进度时间线卡片（长任务）

**不显示百分比、不显示"第 N 步 / 共 M 步"**（§6.1）。

```
┌────────────────────────────────────────────────┐
│ ● 正在检索与核验                   已用 26:53  │   ← 阶段名 text-ui 600 + odometer text-caption mono tabular
│ ────────────────────────────────────────────── │
│ ✓ 计划已写入 · 3 件交付物            1:12      │   ← 已完成里程碑，✓ 用 --verify-ok
│ ✓ 已委派 clinical-evidence          1:20      │
│ ● 子代理 1 · ≥70 岁阿司匹林一级预防   24:52     │   ← 运行中，脉冲点 --info-600
│   已保存 12 篇来源 · 写出 4 个文件              │   ← 可验证的产物计数 text-caption --muted
│ ○ 子代理 2 · 不良反应谱              待开始     │
│ ────────────────────────────────────────────── │
│ 73.8M tok · 2 个子代理            [停止] [查看] │   ← 消耗计 + 可中断
└────────────────────────────────────────────────┘
```

| 项 | 规格 |
|---|---|
| 卡片 | `--radius-card`，边 `1px --border`，内边距 16px，底 `--surface` |
| 阶段行 | `text-ui` 600 + 右侧已用时（`text-caption` mono `tabular-nums`） |
| 里程碑行 | 高 28px，图标 14×14；✓ `--verify-ok` / ● `--info-600` 脉冲 / ○ `--n-400` 空心 |
| 产物计数 | `text-caption --muted`，只写**可验证的事实**（保存了几篇来源、写出几个文件） |
| 底栏 | token / 子代理数（mono tabular）+ **[停止]** 与 **[查看]** —— 可中断是硬要求（§6.1） |
| 禁止 | 进度条、百分比、"预计剩余"、与真实工作解耦的轮播文案 |
| 数据来源 | 内核已有的 `ui-plan` / `ui-subagent` / `ui-deliverables`（F3 记录它们**未被禁用**）—— 不需要新建管道 |

### 10.6 引文 chip + 证据悬浮卡

**chip（行内）**

| 项 | 规格 |
|---|---|
| 形状 | 上标数字，`text-caption` mono，`--radius-chip`，内边距 `1px 5px` |
| 色 | 字 `--link`，底 `--info-50`；hover 底 `--info-100` |
| 命中 | 行内目标豁免 2.5.8，但**命中区仍补到 ≥20px 高**（`padding-block`），且相邻 chip 间距 ≥4px |
| 焦点 | `:focus-visible` 显示焦点环并**自动打开**悬浮卡（hover-only 内容必须 focus 可达） |

**悬浮卡（三段式 —— 这是 EviMed 与 Perplexity/NotebookLM 的差异点）**

| 段 | 内容 | 规格 |
|---|---|---|
| ① 引文 | 被绑定的**逐字原文** | 14px/1.7，左 3px `--border-strong` 边，`--surface-2` 底，可选中复制；>4 行折叠 |
| ② 来源 | 题名 · 期刊 · 年 · **DOI/PMID（mono）** | `text-ui-sm`；DOI 可点，打开公共源网关解析 |
| ③ 核验 | `✓ 已核验：引文与来源逐字一致` 或 `⚠ 待核：来源未陈述该数字` | `text-caption`，色 `--verify-ok` / `--verify-pending` |
| 容器 | 宽 **360px**（窄屏 `min(360px, calc(100vw - 32px))`），`--radius-card`，`--shadow-pop`，内边距 12px | |
| 动效 | 入场 `--dur-fast` `--ease-decelerate`，淡入 + 2px 上移；hover 延迟 150ms 打开、100ms 关闭 | |
| 数据 | 来自 `claim_verification` → `claimVerification`（`packages/domain`），已存在 | |

### 10.7 主张核验标记（✓ / ⚠）

| 形态 | 规格 |
|---|---|
| ✓ 已核验 | lucide `check` 12×12，色 `--verify-ok`，紧跟主张末尾，前置 2px 间隙；`title="已核验：引文与来源逐字一致"` |
| ⚠ 待核 | lucide `circle-help` 12×12（**不是三角感叹号**），色 `--verify-pending`；`title="待核：{一句话原因}"` |
| 胶囊形态（矩阵/列表里） | 高 20px，`--radius-chip`，内边距 `0 8px`，`text-caption`；✓ = `--brand-800` 字 / `--brand-50` 底（7.26:1）；⚠ = `--warn-800` 字 / `--warn-50` 底（7.80:1） |
| SAFETY | **唯一允许用红的核验类标记**：`--danger-800` 字 / `--danger-50` 底（8.13:1），图标 `shield-alert` |
| 硬规则 | **⚠ 永不用红、永不用实色块、永不用三角感叹号**（§1.2 告警疲劳 + §1.3 中文红绿 + §1.4 WCAG 1.4.1） |
| 冗余编码 | 颜色 + 图标形状 + `title`/屏幕阅读器文字，三通道齐备 |

### 10.8 证据矩阵表格

| 项 | 规格 |
|---|---|
| 行高 | **36px**（紧凑，默认）/ 44px（标准），可切换 |
| 表头 | 吸顶（`position: sticky; top: 0`），底 `--surface-2`，`text-ui-sm` 600，下边 `1px --border-strong` |
| 首列 | **冻结**（`position: sticky; left: 0`），底 `--surface`，右侧 `1px --border`；内容为主张编号 + 类型标记 |
| 行分隔 | `1px --border-faint`，**不用斑马纹**（§4.2：状态底色会被吃掉） |
| hover | 整行底 `--surface-2` |
| 选中 | 整行底 `--accent-soft`，首列左侧 2px `--accent` |
| 数字列 | 右对齐，`tabular-nums`，小数位统一 |
| 文本列 | 左对齐，`line-clamp: 2`，hover 显示完整（tooltip 或行展开） |
| 主张类型 | direct / synthesized / derived 用**三种形状的小标记**而非三种颜色：● 实心 / ◐ 半填 / ◇ 空心菱形 + `text-caption` 文字 |
| 核验列 | 10.7 的胶囊形态 |
| 窄屏 | 横向滚动 + 冻结首列 + 右侧滚动渐隐（`scroll-fade`），不折叠成卡片（矩阵的价值就是横向对比） |
| 空态 | 「本次运行还没有产出证据矩阵」+ 指向运行记录的按钮 |

### 10.9 右栏页签

| 项 | 规格 |
|---|---|
| 默认宽 | **360px**（现状 528px 过宽，§4.1）；可拖 320–480；`< 1280px` 视口改为右侧覆盖层 |
| 页签条 | 高 40px，底 `--surface`，下边 `1px --border`；页签 `text-ui-sm`，内边距 `0 12px` |
| 选中态 | 字 `--text` 600 + 下方 2px `--accent`；未选中 `--muted` |
| 页签数 | ≤4 个；超出并入「更多」 |
| 头部控件 | 新标签页 / 分栏 / 全屏 / 收起 —— 图标按钮 28×28（命中 ≥24×24），`aria-label` 必填 |
| 空态 | **不允许出现"能打开但什么都没有"的标签页**（现状：「新标签页」打开空白，因为没有注册任何标签类型，F2）。没有可用类型时，按钮应禁用并给出原因 |
| 拖柄 | 6px 宽独立列，`cursor: col-resize`，`role="separator"` + `aria-valuenow` + 方向键步进 16px（键盘可达） |
| 持久化 | 宽度与选中页签跨会话保存（§4.1） |

---

## 11. 交付物 E：EviMed `DESIGN.md` 草案

> 按 §前置 实测到的 DESIGN.md 约定书写：YAML frontmatter（机器可读）+ 固定章节正文。
> 下面这份可直接落到仓库根（或 `OpenScience/DESIGN.md`）。采用方向 A。
> **注意**：落地前需与 `OpenScience/AGENTS.md` 的「避免新增 Markdown 文档」一条确认 ——
> `DESIGN.md` 属于 token 单一事实源的机器可读面，不是说明文档，建议作为例外接受。

````markdown
---
version: 0.1-draft
name: EviMed-design-system
description: >
  A calm clinical instrument for evidence-based medicine. Cool paper canvas, deep teal
  brand, hairline structure, almost no shadow. Colour is rationed: red is reserved for
  danger and unread work, amber for "needs checking", teal for the product's own promise
  (a verified claim). Typography does the hierarchy work, not colour blocks. Chinese is
  the baseline UI language; Latin faces lead the stack so numbers, DOIs and identifiers
  keep their metrics. Every status is encoded three times — colour, shape, text.

colors:
  # brand — OKLCH H=185, generated on a fixed L ladder, chroma clamped to sRGB
  brand-50:  "#f0fbf9"
  brand-100: "#e1f7f3"
  brand-200: "#c3ece6"
  brand-300: "#98dbd2"
  brand-400: "#63c5b9"
  brand-500: "#26ac9f"
  brand-600: "#008f84"
  brand-700: "#00756b"
  brand-800: "#005e56"
  brand-900: "#004841"
  brand-950: "#002d29"
  # neutral — OKLCH H=232, C<=0.010 (cool paper)
  n-50:  "#f8f8f9"
  n-100: "#f0f1f2"
  n-150: "#e9ebed"
  n-200: "#dfe2e4"
  n-300: "#c8cdcf"
  n-400: "#acb2b5"
  n-500: "#90979b"
  n-600: "#767d81"
  n-700: "#606669"
  n-800: "#4c5154"
  n-900: "#3a3e40"
  n-950: "#242628"
  # semantic ramps (shared by both themes)
  danger-50:  "#fff6f5"
  danger-300: "#ffb7ae"
  danger-600: "#cf463e"
  danger-700: "#af302b"
  danger-800: "#8f2320"
  warn-50:  "#fff7ef"
  warn-300: "#efc392"
  warn-600: "#ab6c00"
  warn-700: "#8c5700"
  warn-800: "#704500"
  ok-50:  "#f3fbf4"
  ok-300: "#aadbb3"
  ok-600: "#3a9052"
  ok-700: "#25773e"
  info-50:  "#f4f9ff"
  info-300: "#aacfff"
  info-600: "#1f7ae0"
  info-700: "#0362bf"
  # semantic aliases — light
  bg:            "{colors.n-50}"
  surface:       "#ffffff"
  surface-2:     "{colors.n-100}"
  border-faint:  "{colors.n-150}"
  border:        "{colors.n-200}"
  border-strong: "#8e969b"
  text:          "{colors.n-950}"
  muted:         "{colors.n-700}"
  accent:        "{colors.brand-700}"
  accent-fg:     "#ffffff"
  accent-soft:   "{colors.brand-50}"
  link:          "{colors.info-700}"
  focus:         "{colors.brand-700}"
  badge:         "{colors.danger-700}"
  verify-ok:     "{colors.brand-700}"
  verify-pending:"{colors.warn-800}"
  # semantic aliases — dark (same names, different values; never invert the light set)
  dark-bg:            "#14181a"
  dark-surface:       "#1d2225"
  dark-surface-2:     "#272d30"
  dark-border-faint:  "#292f32"
  dark-border:        "#3a4044"
  dark-border-strong: "#646c71"
  dark-text:          "{colors.n-100}"
  dark-muted:         "{colors.n-400}"
  dark-accent:        "{colors.brand-400}"
  dark-accent-fg:     "#14181a"
  dark-accent-soft:   "{colors.brand-900}"
  dark-link:          "{colors.info-300}"
  dark-verify-ok:     "{colors.brand-300}"
  dark-verify-pending:"{colors.warn-300}"

typography:
  fontFamilySans: >
    Inter, "SF Pro Text", system-ui, "PingFang SC", "HarmonyOS Sans SC", "MiSans",
    "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif
  fontFamilySerif: >
    "Source Serif 4", Georgia, "Songti SC", "Noto Serif CJK SC", "Source Han Serif SC", serif
  fontFamilyMono: >
    "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, "Noto Sans Mono CJK SC", monospace
  caption: { fontFamily: "{typography.fontFamilySans}", fontSize: 12px, fontWeight: 400, lineHeight: 1.5 }
  ui-sm:   { fontFamily: "{typography.fontFamilySans}", fontSize: 13px, fontWeight: 400, lineHeight: 1.55 }
  ui:      { fontFamily: "{typography.fontFamilySans}", fontSize: 14px, fontWeight: 400, lineHeight: 1.6 }
  body:    { fontFamily: "{typography.fontFamilySans}", fontSize: 16px, fontWeight: 400, lineHeight: 1.75 }
  prose:   { fontFamily: "{typography.fontFamilySans}", fontSize: 16px, fontWeight: 400, lineHeight: 1.8 }
  title:   { fontFamily: "{typography.fontFamilySerif}", fontSize: 20px, fontWeight: 600, lineHeight: 1.35 }
  display: { fontFamily: "{typography.fontFamilySerif}", fontSize: 26px, fontWeight: 600, lineHeight: 1.25 }
  code:    { fontFamily: "{typography.fontFamilyMono}", fontSize: 13.5px, fontWeight: 400, lineHeight: 1.6 }

rounded:
  chip: 999px
  input: 8px
  card: 12px
  panel: 16px

spacing:
  unit: 4px
  scale: [0, 4, 8, 12, 16, 24, 32, 48, 64]
  rowCompact: 36px
  rowStandard: 44px
  cardPadding: 16px
  sectionGap: 32px
  measure: 680px
  sidebar: 264px
  rightPane: 360px

motion:
  instant: 100ms
  fast: 160ms
  base: 240ms
  slow: 320ms
  easeStandard: "cubic-bezier(0.2, 0, 0, 1)"
  easeDecelerate: "cubic-bezier(0, 0, 0, 1)"
  easeAccelerate: "cubic-bezier(0.3, 0, 1, 1)"

elevation:
  flat: "none"
  pop: "0 4px 16px rgba(20,24,26,.10), 0 1px 3px rgba(20,24,26,.06)"
  modal: "0 16px 48px rgba(20,24,26,.18), 0 2px 8px rgba(20,24,26,.08)"

components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-fg}"
    typography: "{typography.ui}"
    rounded: "{rounded.input}"
    height: 36px
    padding: 0 16px
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text}"
    borderColor: "{colors.border-strong}"
    rounded: "{rounded.input}"
    height: 36px
  button-danger:
    backgroundColor: "{colors.danger-700}"
    textColor: "#ffffff"
    rounded: "{rounded.input}"
  card:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.card}"
    padding: "{spacing.cardPadding}"
    boxShadow: "{elevation.flat}"
  popover:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
    rounded: "{rounded.card}"
    boxShadow: "{elevation.pop}"
  text-input:
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border-strong}"
    focusBorderColor: "{colors.accent}"
    rounded: "{rounded.input}"
    height: 36px
    typography: "{typography.ui}"
  badge-unread:
    backgroundColor: "{colors.badge}"
    textColor: "#ffffff"
    rounded: "{rounded.chip}"
    height: 16px
    typography: "{typography.caption}"
  chip-neutral:
    backgroundColor: "{colors.surface-2}"
    textColor: "{colors.muted}"
    rounded: "{rounded.chip}"
    height: 20px
    typography: "{typography.caption}"
  chip-verified:
    backgroundColor: "{colors.brand-50}"
    textColor: "{colors.brand-800}"
    rounded: "{rounded.chip}"
    height: 20px
  chip-needs-check:
    backgroundColor: "{colors.warn-50}"
    textColor: "{colors.warn-800}"
    rounded: "{rounded.chip}"
    height: 20px
  chip-safety:
    backgroundColor: "{colors.danger-50}"
    textColor: "{colors.danger-800}"
    rounded: "{rounded.chip}"
    height: 20px
  citation-chip:
    backgroundColor: "{colors.info-50}"
    textColor: "{colors.link}"
    rounded: "{rounded.chip}"
    typography: "{typography.caption}"
  table-row:
    height: "{spacing.rowCompact}"
    borderColor: "{colors.border-faint}"
    hoverBackgroundColor: "{colors.surface-2}"
    selectedBackgroundColor: "{colors.accent-soft}"
  table-header:
    backgroundColor: "{colors.surface-2}"
    borderColor: "{colors.border-strong}"
    typography: "{typography.ui-sm}"
  sidebar:
    width: "{spacing.sidebar}"
    backgroundColor: "{colors.bg}"
    borderColor: "{colors.border}"
  right-pane:
    width: "{spacing.rightPane}"
    backgroundColor: "{colors.surface}"
    borderColor: "{colors.border}"
  focus-ring:
    outline: "2px solid {colors.focus}"
    outlineOffset: 2px
---

## Overview

EviMed is a hosted AI research workbench for evidence-based medicine. The people using it are
clinicians, clinical pharmacists and medical researchers, reading dense mixed Chinese/English
scientific text for an hour at a time. The interface must read as an **instrument**, not as a
chat product.

Three ideas carry the whole system:

1. **Colour is rationed.** One brand hue (deep teal), one neutral ramp, four semantic ramps.
   Coloured pixels cover less than 5% of any screen. Red is reserved for two things only:
   danger, and work the user has not handled yet.
2. **Lines, not shadows.** Structure comes from 1px hairlines and surface steps. Static cards
   have no shadow at all; only things that genuinely float (menus, popovers, modals) cast one.
3. **Every status is said three times** — colour, shape, and words. Because red and green mean
   the opposite things in Chinese markets than they do in Western ones, and because 8% of male
   users cannot separate them at all.

**Key Characteristics**
- Cool paper canvas `{colors.bg}` (#f8f8f9) with near-black cool ink `{colors.text}` (#242628).
- Deep teal brand `{colors.accent}` (#00756b) — in the same family as the product's own favicon.
  It marks primary actions and, deliberately, a verified claim: the product's core promise.
- Amber `{colors.verify-pending}` for "needs checking". **Never red.** A claim awaiting
  verification is not a clinical alarm.
- Hairline structure: `{colors.border}` for decoration, `{colors.border-strong}` for anything
  that is the visible boundary of a control.
- Typography carries the hierarchy: 6 rungs, 2 weights (400/600), 16px body at 1.75, measure
  capped at 680px (~42 Chinese characters per line).
- Numbers are tabular everywhere. Identifiers (DOI, PMID, NCT, run id) are monospace, so a
  reader can check them character by character.

## Colors

### Brand & Accent
- **Teal 700** (`{colors.accent}` — #00756b): primary buttons, active navigation, focus ring,
  the ✓ verified mark. 5.59:1 on white.
- **Teal 400** (`{colors.dark-accent}` — #63c5b9): the same role in dark mode. 7.81:1 on
  `{colors.dark-surface}`.
- **Teal 50 / 900** (`{colors.accent-soft}` / `{colors.dark-accent-soft}`): selected rows,
  hovered menu items, the verified chip's background. Never for text.

### Surface
Light: `bg` → `surface` → `surface-2` is a three-step ladder from canvas to raised panel.
Dark: the same three names point at `#14181a` → `#1d2225` → `#272d30`; each added layer gets
one step lighter, never a lightened copy of the light theme.

### Text
- `text` (#242628) — body and headings. 15.19:1 on white.
- `muted` (#606669) — captions, metadata, secondary rows. 5.83:1 on white, 5.16:1 on surface-2.
- Nothing lighter than `muted` may carry text.

### Semantic
- `danger` — errors, destructive actions, unread badges, and SAFETY findings. Nothing else.
- `warn` — needs checking, degraded capability, expired credential.
- `ok` — a completed operation. **Not** the verified mark (that is the brand).
- `info` — links, running state, citation chips.

## Typography

### Font Family
Latin faces lead (`Inter`, `SF Pro Text`), Chinese faces follow (`PingFang SC`,
`HarmonyOS Sans SC`, `MiSans`, `Microsoft YaHei`, `Noto Sans CJK SC`). The stack is written
out in full: browser defaults for CJK differ per OS and per Chrome version, and on Windows an
unnamed `serif` falls to bitmap-hinted SimSun.

### Hierarchy
`caption 12/1.5` · `ui-sm 13/1.55` · `ui 14/1.6` · `body 16/1.75` · `prose 16/1.8` ·
`title 20/1.35 serif` · `display 26/1.25 serif`.

### Principles
- Two weights only: 400 and 600. Chinese screen fonts have no true 500; asking for it makes
  the Latin run bold while the Chinese run does not.
- Never add `letter-spacing` to Chinese.
- Mixed-script spacing is the browser's job, not the model's:
  `text-autospace: ideograph-alpha ideograph-numeric` (Chrome 140+, Firefox 145+, Safari 18.4+;
  all three ship it initially off, so it must be written explicitly).
  `text-spacing-trim: normal` as progressive enhancement (Chromium only).
- Serif is for titles and report covers. It never carries Chinese body text.

### Note on Font Substitutes
If `Inter` or `Source Serif 4` are unavailable, fall back to the system UI sans and Georgia.
Do not substitute a different Chinese face — the metrics of the whole scale were measured
against PingFang SC / Microsoft YaHei.

## Layout

### Spacing System
4px base. Rows 36px (compact) / 44px (standard). Card padding 16px. Section gap 32px.
Page padding 32px — never the 96px marketing-page rhythm.

### Grid & Container
Sidebar 264px (drag 240–320, collapse to 56px). Centre column minimum 640px, prose capped at
680px. Right pane 360px (drag 320–480), becomes an overlay below 1280px.
Containers: 640 / 680 / 1000 / 1120.

### Whitespace Philosophy
This is a dense tool. Whitespace separates *groups*, not every element. A list of 20 runs
should fit on a laptop screen without scrolling to find the fourth one.

## Elevation & Depth

Three levels: `flat` (none), `pop`, `modal`. Static cards are `flat` + a 1px border. In dark
mode shadows are invisible; depth comes from the surface ladder instead.

## Shapes

`chip 999px` · `input 8px` · `card 12px` · `panel 16px`. Nothing else.

## Components

See `components:` in the frontmatter. Every component reads its values from `{colors.*}`,
`{typography.*}`, `{rounded.*}` — a literal hex or px in a component is a defect.

Six states on every interactive component: default, hover, active, focus-visible, disabled,
loading. Focus ring is 2px `{colors.focus}` at 2px offset, on everything, always.

Minimum hit area 24×24 CSS px (WCAG 2.2 SC 2.5.8); 32×32 for icon-only buttons in the chrome.

## Do's and Don'ts

### Do
- Ration colour. If a screen has more than three coloured elements, one of them is wrong.
- Encode status three ways: colour, shape, words.
- Use `border-strong` for the visible boundary of a control; `border` is decoration only.
- Show odometers (elapsed, tokens, steps, artifacts written) for long work.
- Right-align numbers and set `tabular-nums`.
- Put identifiers in monospace so they can be checked character by character.
- Keep prose to 680px.
- Give every failure a next action.

### Don't
- Don't use red for anything but danger and unhandled work.
- Don't make "needs checking" look like a clinical alarm.
- Don't put a percentage or a progress bar on an agent run.
- Don't use gradients, sparkles, glows, or coloured shimmer.
- Don't use `font-weight: 500` on Chinese.
- Don't put a shadow on a static card.
- Don't let a badge cover the icon it sits on.
- Don't render two adjacent rows with identical text.
- Don't show raw validator strings, enum codes, run ids or model names in the body of the UI.
- Don't rely on hover to reveal anything a keyboard user needs.

## Responsive Behavior

### Breakpoints
`sm 640` · `md 768` · `lg 1024` · `xl 1280` · `2xl 1536`.

### Touch Targets
≥24×24 CSS px everywhere; 32×32 for chrome icon buttons; inline citation chips are exempt
by the inline-target exception but still get ≥20px block padding and ≥4px separation.

### Collapsing Strategy
`<1280`: right pane becomes an overlay. `<1024`: sidebar collapses to a 56px icon rail.
`<768`: sidebar becomes a drawer, prose gets 16px side padding, tables scroll horizontally
with the first column frozen. Verified at 390px: no horizontal overflow anywhere.

### Image Behavior
Figures keep a white paper background in both themes (a chart printed on a dark card is
unreadable and unprintable). That exception is named: `paper-bg` / `paper-text`, not a
hardcoded hex.

## Iteration Guide

**May be changed** without review: spacing within the scale, row density, which of the four
containers a page uses, icon choices within lucide.

**Requires review**: any new colour token; any change to a ramp's L ladder; a new blocking
visual state; anything that adds a coloured element to a screen that already has three.

**May never be changed here**: chart series colours (`--series-1..8`) — they are shared with
`@ai4s/shared` and the matplotlib style and must be changed in all three at once, with the
dataviz validator run.

## Known Gaps

- The chat surface is a third-party agent client in an iframe, themed through `--dsw-*`
  custom properties. The mapping in §7.6 of the design research is proposed, not yet verified
  on a live session; the frame's own values read back empty from `:root`.
- Print / PDF styles for delivered reports are not specified.
- Chart typography inside matplotlib-rendered figures is not covered by this file.
- No motion spec for the streaming text itself (buffering cadence is an engineering decision).
- Data density for the knowledge-base file tree has not been measured against real corpora.
````

---

## 12. 交付物 F：Do / Don't（中文版，可直接贴进评审单）

### 颜色

| ✅ Do | ❌ Don't |
|---|---|
| 一屏内彩色元素 ≤3 个 | 把品牌色同时用在主按钮、分类标签、未读徽标上 |
| 红只用于**危险**与**未处理的事** | 用红做"重点"、做分类、做品牌 |
| "待核"用琥珀软底 + 深字 | 让"待核"长得像临床告警（红底、三角感叹号） |
| 控件边界用 `--border-strong`（≥3:1） | 用装饰性 `--border` 当输入框边界 |
| 深色模式从色阶低档取值 | 把浅色值取反当深色值 |
| 改色前用 `node` 实算对比度并写进注释 | 靠肉眼"看起来够深了" |

### 排印

| ✅ Do | ❌ Don't |
|---|---|
| 正文 16px / 1.75，行宽 ≤680px | 760px 宽的 15px 中文正文（50 字/行） |
| 字重只用 400 / 600 | 给中文用 500 |
| 显式写 `text-autospace: ideograph-alpha ideograph-numeric` | 让模型在文本里手打中英空格 |
| 数字 `tabular-nums` + 右对齐 | 表格里左对齐的数字、不统一的小数位 |
| DOI/PMID/id 用等宽 | 把标识符混进正文字体 |
| 衬线只做标题 | 中文正文用衬线（Windows 落到点阵宋体） |

### 状态与进度

| ✅ Do | ❌ Don't |
|---|---|
| 显示已用时 / token / 步数 / 已写出的产物 | 显示百分比、进度条、"预计剩余" |
| 状态 = 颜色 + 形状 + 文字 | 只用圆点颜色区分状态 |
| 长任务始终可停止、可查看 | 26 分钟只显示一行"深度求索中..." |
| 加载 >3s 用骨架 + 真实里程碑 | 10 秒白屏配一行灰字 |
| 失败给下一步动作 | 只读的错误文本 |

### 组件

| ✅ Do | ❌ Don't |
|---|---|
| 图标按钮命中区 ≥24×24（chrome 用 32×32） | 14×14 的铃铛 |
| 徽标 ≤16px 且落在图标外沿 | 徽标盖住图标 |
| 15 项能力用可扫读的紧凑行 + 搜索 + ≤6 个分类 chips | 15 张 220px 高的卡片 |
| 静态卡片用 1px 边框 | 给静态卡片加阴影 |
| 同名行补日期/问题片段 | 侧栏 11 行「临床证据深度分析」 |
| 收件箱条目是中文一句话 + 一个主动作 | 把英文校验器原文打在卡片正文里 |

### AI 表达

| ✅ Do | ❌ Don't |
|---|---|
| 工具调用用带标签的系统行（`Marker` 形态） | 把工具调用做成气泡或大卡片 |
| "正在处理"用同色系明度微光 | 蓝色渐变文字、彩色 shimmer |
| 推理默认折叠、可展开 | 把思考过程当正文渲染 |
| 引文 chip + 三段式悬浮卡（原文 / 来源 / 核验） | 只给一个跳转链接 |
| 界面文案不出现模型名 | 在 UI 里写 "DeepSeek V4 Pro" |

## 13. 与既有本地规范的对照与冲突

### 13.1 与 `docs/ui-ux-audit/02-前端设计规范建议.md`（本产品早先的建议）

| 条目 | 早先建议 | 本次建议 | 关系 |
|---|---|---|---|
| 对比度修订 | muted/accent/warn/ok/error 全部加深到 ≥4.5:1 | 已落地（`index.css:21-34`），本次实算复核全部 PASS 但**无余量** | ✅ 一致，本次补"余量"要求 |
| 色板 | **维持** `--bg #f7f5ef` 暖米，accent 只加深到 `#b04e2a` | **替换**为冷纸 + 深青 | ⚠️ **冲突**。早先文档写于"把现有暖纸+赤陶体系化"的前提；本次新增的事实是它与 Claude 品牌同构（§前置），这个前提不再成立 |
| 字号刻度 | caption 11 / ui-sm 12.5 / **ui 13.5** / body 15 | caption 12 / ui-sm 13 / **ui 14** / body 16 | ⚠️ 部分冲突。11/12.5 已在 2026-09-16 被仓库自己改为 12/13（CJK 笔画在 12px 以下并笔）；本次进一步把 ui 提到 14（消灭半像素 + 对齐 Ant/TDesign）、body 提到 16（对齐框架） |
| 圆角 | input 10 / card 14 / chip 999 | input 8 / card 12 / panel 16 / chip 999 | ⚠️ 轻冲突。14px 偏消费级；参照四份实测 DESIGN.md 的 8/12/16 层级 |
| 阴影 | 两档 `shadow-card` / `shadow-pop` | **取消 `shadow-card`**，静态卡片只用 1px 边框；保留 pop 与新增 modal | ⚠️ 冲突。理由见 §4.6 |
| 容器宽度 | narrow 672 / content 760 / wide 1024 / full 1080 | 640 / **680** / 1000 / 1120 | ⚠️ 冲突。760px 的 15px 中文 = 50 字/行，超出建议区间 |
| 点击目标 | ≥32px | **硬底线 24×24（WCAG 2.2 AA）**，chrome 图标按钮 32×32 | ✅ 不冲突，32 更严；本次给出可审计的法定下限 |
| z-index 刻度 | base/sticky/overlay/drawer/modal/popover/toast | 原样采纳 | ✅ |
| 状态冗余编码 | "颜色 + 形状/文字/图标"，点名侧栏恒绿圆点 | 原样采纳并给出四态规格（§10.3） | ✅ |
| 品牌资产 | 替换残留上游蓝 `#2563eb`（favicon / theme-color / PWA） | 同意，并指出 **favicon 绿 `#1f6f5c` 才是对的那个** —— 方向 A 让它扶正，logo 蓝改掉 | ✅ 深化 |
| `packages/ui` 两期计划 | 一期就地收敛 8 原语 | 不变（本次不涉及） | ✅ |

### 13.2 与 `/home/coder/workspace/深圳医保局/docs/DESIGN_GUIDELINES.md`（同一 owner 的兄弟医疗平台）

| 兄弟平台的规则 | EviMed 现状 | 建议 |
|---|---|---|
| **硬规则 1**：任何服务端枚举/状态码/错误码渲染前必须过 `StatusLabel` 中文映射，未登记的码显示原码 + "未登记"提示 | ❌ **违反**。收件箱直接打印 `claims[52].claim numeric fact 6 is not present…`；运行记录页有「技术标识（供排查使用）」 | **照搬这条规则**。EviMed 需要一个等价的 `StatusLabel` + 映射注册表 |
| **§6**：内部标识不上界面（数据集编号、版本哈希、校验码、引擎版本、模型名称） | ❌ 部分违反（技术标识、校验器原文） | 采纳；原始文本放「技术详情」折叠 |
| **§5**：一页一个主按钮，次按钮 ≤2，其余进「更多操作」 | 未系统执行 | 采纳 |
| **§6**：第一屏先给结论，长解读默认收起；折叠只有一种实现 `Disclosure` | 部分具备 | 采纳 |
| **§6**：窗口本身不滚动，滚动只在内容区 | 三栏工作台天然一致 | 采纳并加入验收单 |
| **§7**：图表分类色只取 `chartPalette()`，改动必须跑 dataviz 校验（色盲 ΔE ≥8、正常视觉 ≥15） | EviMed 已有 `--series-1..8` 三方同源 | ✅ 一致；本次**不动图表色** |
| **§7**：AI 生成内容必须带「AI 生成」标；界面与交付包不出现模型名称。依据《人工智能生成合成内容标识办法》（2025-09-01 施行） | EviMed 无此标识 | ⚠️ **需 owner 决定**。仓库记忆里有一条"合规与版权不在 EviMed 设计范围内（owner 持有正式资质，不做同意弹窗/法律门禁/版权检查）"——但**内容标识**与同意弹窗不是同一类东西。本调研只标出差异，不替 owner 下结论 |
| 共享组件索引（Button/Card/DataTable/StatusChip/EmptyState/ConfirmDialog/Skeleton/TermHint…） | EviMed 的 `components/ui/` 较薄 | 可直接借鉴组件清单与四态纪律 |
| PR 检查单（16 条） | EviMed 无等价物 | 建议把本文件 §12 的 Do/Don't 做成同样的 PR 勾选单 |

**一条值得注意的不一致**：兄弟平台的图表分类色以**赭红**打头，EviMed 的 `--series-1` 是蓝 `#2a78d6`。
两个产品本来就该有不同的品牌色；本次建议进一步拉开（EviMed 走青绿）。这不是冲突，是有意的区分。

---

## 附录：来源清单

**设计系统与 token 方法论**
- DESIGN.md 约定：<https://betterstack.com/community/guides/ai/design-md-ai/> · <https://github.com/voltagent/awesome-design-md>
- 实测原文（frontmatter 与章节结构逐字核对）：
  `design-md/{claude,linear.app,stripe,notion,vercel}/DESIGN.md`，
  例 <https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/claude/DESIGN.md>
- Radix Colors 12 档角色表与 APCA 保证：<https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale>
- Tailwind v4 的 OKLCH 重推导：<https://tailwindcss.com/blog/tailwindcss-v4>
- OKLCH 说明：<https://trypeek.app/blog/oklch-explained-what-it-is-why-tailwind-v4-uses-it-how-to-convert/>
- IBM Carbon 色 token 与主题分层：<https://carbondesignsystem.com/elements/color/overview/> · <https://carbondesignsystem.com/elements/themes/overview/>
- Adobe Leonardo（按目标对比度生成色）：<https://github.com/adobe/leonardo> · <https://adobe.design/toolkit/leonardo>

**可访问性**
- WCAG 2.2 全文：<https://www.w3.org/TR/WCAG22/>
- 2.5.8 目标尺寸理解文档：<https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>
- 状态指示器的冗余编码：<https://www.accessibility.chat/articles/when-color-coding-fails-why-status-indicators-need-more-than-pretty-colors> · <https://dev.to/pasindu_balasooriya/when-red-means-nothing-designing-colour-blind-safe-uis-for-emergency-dispatch-systems-40lj>

**医疗 UI 与色彩**
- NHS 数字服务手册 · 颜色：<https://service-manual.nhs.uk/design-system/styles/colour>
- NHS 品牌规范 · 颜色（Emergency Services Red）：<https://www.england.nhs.uk/nhsidentity/identity-guidelines/colours/>
- 告警疲劳：<https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9754301/> · <https://ncbi.nlm.nih.gov/pmc/articles/PMC4173170> · <https://pubmed.ncbi.nlm.nih.gov/39049299/>
- 医疗告警的跨行业人因综述：<https://patientsafetyj.com/article/73905-informing-healthcare-alarm-design-and-use-a-human-factors-cross-industry-perspective>
- 中西股市红绿反转：<http://caijing.chinadaily.com.cn/2015-07/27/content_21415547.htm> · <https://www.163.com/dy/article/KHFURR1R05562F45.html> · <https://m.ui.cn/details/665942>

**中文排印**
- W3C 中文排版需求：<https://www.w3.org/TR/clreq/> · 差距分析 <https://www.w3.org/TR/clreq-gap/>
- `text-autospace`：<https://developer.mozilla.org/en-US/docs/Web/CSS/text-autospace>
- `text-spacing-trim`：<https://developer.mozilla.org/en-US/docs/Web/CSS/text-spacing-trim>
- 浏览器兼容数据（本文表格的数字出处）：<https://github.com/mdn/browser-compat-data>
  （`css/properties/text-autospace.json`、`css/properties/text-spacing-trim.json`，2026-09-18 拉取）
- Chrome 的国际化 CSS 特性：<https://developer.chrome.com/blog/css-i18n-features>
- Chromium 在 Windows 上改用 Noto CJK 的公告与回归：
  <https://groups.google.com/a/chromium.org/g/blink-dev/c/t1Mc7oJdNQY> · <https://issues.chromium.org/issues/409486609>
- Ant Design 字体规范：<https://ant.design/docs/spec/font-cn/>
- TDesign 字体规范：<https://tdesign.tencent.com/design/fonts>（行高公式摘要 <https://modao.cc/ad/blog/TDesign-component-library.html>）
- 中文行长与行距：<https://m.ui.cn/details/567154> · <https://www.woshipm.com/pd/5823078.html> · <https://zhuanlan.zhihu.com/p/207951692>
- 中文网页字体选型（SimSun 点阵、iOS 无 CJK 衬线）：<https://weixiang.github.io/posts/the-font-selection-and-development-guide-in-chinese-web-pages/> · <https://woft.name/wp/get-rid-of-ugly-chinese-bitmap-characters/>
- HarmonyOS Sans 免费商用：<https://zhuanlan.zhihu.com/p/680004582>
- Apple 字体（SF Pro SC = 苹方系列）：<https://developer.apple.com/fonts/>

**布局、密度与加载**
- 三栏可调布局：<https://www.techinterview.org/post/3233475299/build-resizable-panels-layout-vscode-linear/> · <https://code.visualstudio.com/docs/configure/custom-layout>
- 数据表设计：<https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-data-tables> · <https://medium.com/design-with-figma/the-ultimate-guide-to-designing-data-tables-7db29713a85a> · <https://stephaniewalter.design/blog/essential-resources-design-complex-data-tables/>
- 响应时间三界限：<https://www.nngroup.com/articles/response-times-3-important-limits/>
- 骨架屏 vs spinner：<https://www.nngroup.com/articles/skeleton-screens/> · <https://www.nngroup.com/videos/skeleton-screens-vs-progress-bars-vs-spinners/>
- Material 3 时长与缓动：<https://m3.material.io/styles/motion/easing-and-duration/tokens-specs>
- Material 3 徽标规格：<https://m3.material.io/components/badges/specs>
- 选项数量阈值（listbox vs dropdown）：<https://www.nngroup.com/articles/listbox-dropdown/>

**AI 界面惯例（2025–2026）**
- 代理进度为什么不能用进度条：<https://tianpan.co/blog/2026/07/02/why-you-cant-put-a-progress-bar-on-an-agent>
- shadcn/ui 聊天组件（`MessageScroller`/`Message`/`Bubble`/`Attachment`/`Marker`/`shimmer`/`scroll-fade`）：<https://ui.shadcn.com/docs/changelog/2026-06-chat-components>
- AI UI 模式：<https://www.patterns.dev/react/ai-ui-patterns/>
- 代理前端设计模式（置信指示器等）：<https://zylos.ai/research/2026-05-28-agentic-ux-frontend-design-patterns-ai-agents/>
- 引文模式：<https://www.shapeof.ai/patterns/citations> · <https://aiuxplayground.com/teardowns/perplexity/citations/> · <https://en.wikipedia.org/wiki/NotebookLM>

**实测抓取（一手）**
- Elicit 首页 HTML 内联色值（`#083d44` ×66、`#fcfcf8` ×6、`#026370`、`#e5ff96`）：<https://elicit.com>
- Consensus 的 CSS bundle（Tailwind v4 `oklch()` + `--color-{green,red,yellow,orange}-faint`）：<https://consensus.app>
- 框架 `--dsw-*` 变量清单 358 个：`docs/ui-ux-audit/2026-09-18-walk/chat.json`
- EviMed 现有 token：`OpenScience/apps/web/src/index.css`、`OpenScience/apps/web/tailwind.config.js`
- 现场发现：`outputs/product-review-2026-09-18/00-live-findings.md`（F2 / F3 / F4 / F6 / F7）
- 截图：`docs/ui-ux-audit/2026-09-18-walk/`（01-runs / 05-capabilities / 06-inbox / 13-chat-tool-row-clicked / 16-chat-subagent-menu / 14-chat-right-panel）

**对比度计算方法**（可复现）
所有 `n:1` 数字由 `node` 实算：sRGB → 线性化（`c<=0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`）
→ 相对亮度 `0.2126R+0.7152G+0.0722B` → `(L1+0.05)/(L2+0.05)`。
OKLCH → sRGB 用标准 Oklab 矩阵，色度超出 sRGB 时二分收缩至在域内（即表中 hex 的实际 C 可能小于名义 C）。
脚本逻辑写在 §7 各表的注释里，未落盘到仓库（本调研不修改仓库文件）。

---

*本文件为调研与提案，未修改仓库中任何代码或配置文件。*
