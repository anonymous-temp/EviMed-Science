# G · 主流产品网页模式调研（定时任务 / 知识库 / GEO 来源分析 / 输入框底部）

调研日期：2026-10-08（所有链接的访问日期均为该日）。目的：为 EviMed 设计计划提供可对照的外部模式。

## 0. 证据分级与读法

- 【一手】厂商官方帮助中心 / 文档 / changelog / 官方博客，我直接抓取到正文。
- 【二手】新闻、第三方教程、论坛、GitHub issue 镜像，或"官方页面本身抓取失败（403/404），只拿到搜索引擎对该页的摘要"。后者在条目里标【二手·搜索摘要】。
- 【实测】我本人在浏览器里直接观察到的界面与量出来的尺寸。
- 条目后的 `[R数字]` 对应文末"参考文献"。
- 凡写"未描述 / 未找到"，意思是"我读到的那一页没有写"，不等于产品没有该功能。
- 抓取受限：chatgpt.com、perplexity.ai 对自动化浏览返回 403；help.openai.com、openai.com/academy、Perplexity 帮助中心的部分文章返回 403/404；claude.ai 需登录。因此 ChatGPT / Perplexity 的界面细节多为二手，下文已逐条标注。
- 命名变化（影响检索旧资料）：NotebookLM 已于 2026-07-16 更名为 Gemini Notebook（Google 官方博客 [R16]）；Codex 的 "automations" 在官方文档里现在叫 "Scheduled tasks"，与 ChatGPT 桌面端合并成同一份文档 [R1]；Gemini 的 Gems 将于 2026 年 11 月从个人账号移除并自动迁为 skills [R18]。

---

## 1. 绑定在对话上的定时任务

### 1.1 逐产品事实

**ChatGPT（含桌面端 Codex 同一套 Scheduled tasks）**

- 任务是不是对话：两种形态并存。【一手】[R1]
  - "Task inside a chat"：到点"回到这个聊天"，沿用该聊天已有上下文，官方称适合持续跟进 / 复查循环。
  - "Standalone scheduled task"：每次运行"start a new chat"，结果汇报到 **Scheduled**，官方称适合每次运行互相独立或一个任务跨多个项目。
  - 创建路径：先在普通聊天里跑一次并调到满意，"留在同一个聊天里告诉 ChatGPT 什么时候重复"，ChatGPT 把这句话转成定时任务。【一手】[R2]
- 列表在哪：侧边栏的 **Scheduled**，是一个页面而不是弹层。【一手】[R1][R2]
  - 官方原话 "acts as your inbox"，列出 active / paused / completed 任务和最近运行，"有运行需要你关注时出现未读指示"。[R1]
  - 页面元素：搜索框 "Search scheduled tasks"；筛选 "All / Active / Paused"；批量动作 "Mark all as read"；每行 = 任务名 + 频率 + 下次运行（例 "Next run in 16 hours"）。[R2]
  - 打开某任务看"最新结果与运行历史"；可编辑指令 / 频率、暂停、删除（官方 walkthrough 未给出菜单项的精确文案）。[R2]
  - Engadget 报道该 Scheduled 页 2026-06-17 上线，描述为侧栏快捷入口，可对"即将运行的请求"暂停 / 编辑 / 删除。【二手】[R4]
- 旧版（2025–2026 初）管理方式：聊天里的任务 pill / 标题点开右侧栏有 edit / pause / manage / delete；删除任务不删聊天，删除关联聊天则任务自动暂停；Settings > Notifications 里可选 Push / Email。【二手·搜索摘要】[R3]
- 立即运行：官方文档只在"事件触发任务的待处理事件"处出现 "Run now"；另有 "Test scheduled tasks" 小节（本次只读到标题）。时间触发任务是否有 Run now，我没有证实。【一手】[R1]
- 能否在线程里回复来改任务：文档有 "Ask ChatGPT to create or update scheduled tasks" 小节（只读到标题）；in-chat 任务因为就在聊天里，自然可以继续追问。【一手·仅标题】[R1]
- 通知：Scheduled 页的未读指示【一手】[R1]；Push / Email 偏好在 Settings > Notifications，浏览器权限关闭时给出提示【二手·搜索摘要】[R3]；桌面通知开启时到点弹出提示【二手】[R4b]。
- 限额 / 预算：按方案限制活跃任务数（Go 3 / Plus 5 / Business·Edu 10 / Pro·Enterprise 15，各版本对 Business 数值不一致），最高每小时一次，满额时不能新建或恢复；聊天里不支持语音和 GPTs。【二手·搜索摘要】[R3]。无人值守运行用默认沙箱：read-only / workspace-write 下越权调用直接失败，full access 被官方标为"提升风险"。【一手】[R1]
- 没有看到任何"单次运行成本 / 预算"的展示。

**OpenAI Codex（桌面应用）**

- 官方文档已并入上面的 Scheduled tasks 页 [R1]。2026-04-23 的 OpenAI Academy 文章把它叫 Automations：到点回来干活并把结果留给你查看，"部分自动化可以重新打开同一个对话并接着上下文做"，建议先和 Codex 来回聊清楚再把任务转成自动化。【二手·搜索摘要，页面 403】[R13]
- 早期文档的收件箱叫 "Triage"：有发现的运行进入 Triage，可筛"全部 / 仅未读"，无发现的运行自动归档。【二手·搜索摘要】[R13]
- 工程侧细节（【一手】[R1]）：Git 仓库里可选"本地项目"或"新建后台 worktree"；高频计划会产生很多 worktree，需要归档不再用的运行，避免 pin 运行；本地文件类任务要求桌面应用保持打开且电脑在线。

**Claude（Cowork 与 Claude Code Desktop）**

- Cowork【一手】[R6]：
  - 创建：任一会话里描述任务与频率，审阅 Claude 给出的名称 / 计划 / 指令后点 "Schedule"；或左侧栏 "Scheduled" → "New task" → "Create with Claude"（Claude 先用选择题追问，再点 "Schedule" 确认）/ "Set up manually"（"Create scheduled task" 弹窗：Task name、Prompt、Approval mode、Frequency（hourly / daily / weekly / on weekdays / manually）、Model（可选）、Folder（可选））。
  - 列表：左侧栏 "Scheduled" 打开 "Scheduled tasks" 页，列全部任务并显示"即将运行与过往运行"。
  - 管理：点进任务可改指令 / 节奏；暂停、恢复、删除；"按需运行"（页面未给精确菜单文案）。
  - 每次运行是 "its own Cowork session"，"像任何其他任务一样"事后查看；不在同一线程。
  - 默认云端运行，电脑休眠 / 应用关闭也跑；需要本地文件或应用的任务只能本地跑。无运行配额说明；通知未写。
- Claude Code Desktop【一手】[R7]：
  - 入口：Code 标签页侧栏 "Routines" → "New routine" → "Local"。字段：Name（kebab-case，作文件夹名）、Description（显示在任务列表）、Instructions（输入框内含权限模式与模型选择器）、Schedule（Manual / Hourly / Daily / Weekdays / Weekly）、工作文件夹（必填）与"是否隔离 worktree"开关。
  - 也可以在任何会话里用自然语言创建，例如"remind me at 3pm tomorrow…"创建一次性任务，触发后自动停用。
  - 点任务进入详情页：**Run now**（立即开始）、**Status**（Active / Paused 开关）、**Edit**、**Review history**（含被跳过的运行，悬停显示原因：电脑休眠 / 上一次未结束 / 其他计划任务占用）、**Always allowed** 面板（查看并撤销已保存的工具授权）、**Delete**（并可勾选同时删磁盘文件）。
  - 到点：桌面通知 + 侧栏 **Scheduled** 分区里出现一个新会话；打开它可以看做了什么、审查改动、或回应权限请求。权限模式为 Manual 且需要未授权工具时，运行会停住等你，会话保留在侧栏供你稍后回答；建议创建后立刻点 Run now 观察并 "always allow"。
  - 漏跑：应用启动 / 电脑唤醒时检查过去 7 天，只补跑最近一次错过的，并弹通知。
  - 任务自身可通过 `update_scheduled_task` 工具在运行中改自己的计划或提示词；也可以在任一会话里让 Claude 列出 / 创建 / 编辑 / 暂停任务。
  - 最小间隔：云端 routines 1 小时，桌面 1 分钟。

**Gemini**

- 现行：Gemini Spark 的 schedules【一手】[R8]：
  - 创建：对话式（切到 Spark，在文本框描述任务点 Submit；也可以在任务线程或 Live 对话里安排）；或 Schedules 页 "Create manually"（名称、何时运行、指令，点 Create；仅限时间触发）。
  - 列表两处：①任务线程左缘 "Close tasks panel" 展开的工作面板，列出**该任务**的计划；②Schedules 页，分 "Ongoing / Paused / Completed" 三区，列所有任务的计划。
  - 菜单（悬停 → More）：**Run now**（页面建议用于测试）、**Edit with Gemini**（在线程里描述改动，适合非时间触发器）、直接编辑后 Save、Pause / Resume（在详情页）、Delete。删除任务线程会连带删除其计划；Completed 的只能删除。
  - 限额：最多 50 个活跃计划；同时最多 15 个任务在跑，满了就不跑；已达用量上限时到点不跑；运行时间是近似值；Spark 关闭则全部暂停；降级订阅则暂停而不删除。时间触发的计划锁定创建时的时区。
  - 结果在哪、如何通知：该页**未写**。
  - 另有 Gmail monitor：邮件命中过滤器时触发任务。
- 旧版 Scheduled Actions（2025-06 上线，付费用户最多 10 个）：设置里有管理页，行内 Pause / Delete，创建后确认卡上有 Pause 按钮。【二手】[R9]

**Perplexity Tasks**

- 官方帮助中心抓取失败，以下都是【二手】。TestingCatalog（2025-06-13）：入口在主菜单 Settings 标签下，按计划跑普通搜索或 Research，面向 Pro / Enterprise，未公开数量与频率上限；定时任务访问不到打开的浏览器上下文。[R10] 2026 年的 Guideflow 教程：账户菜单 → All settings → Notifications → 邮件设置里有 "Scheduled Tasks" 开关；任务卡点开有频率下拉（Once / Daily / Weekly / Every weekday / Monthly）与 Save。[R10b] 任务数上限、结果落点均无官方说法。

**Manus（Automations，原 Scheduled Tasks）**

- 创建与列表【一手】[R11]：左侧栏 "Automations" → "Create" → "Schedule"；"Automations → Manage" 列出有效计划与触发器，卡片显示类型、连接应用、状态、名称、指令。
- 卡片 "More actions" 菜单：暂停、**Test run**（官方建议新建或改动后先测）、"定位原始任务"、编辑、删除。无 "Run now" 文案。
- 结果：**Automations → Updates** 按日期分组列出最近运行（自动化名、运行时间、状态、简短结果摘要），点开看完整结果或"为什么需要关注"；右上角日历图标看月视图（过去与未来计划）。
- Scheduled Tasks 2.0（官方博客，日期写作 "Monday, May 18"，页面未印年份，页脚 ©2026，推断为 2026）【一手】[R12]：
  - 每个计划有运行选项：**保持在同一任务里继续**（可复用该任务的指令、文件、对话、结果）或**每次作为独立任务**；
  - 侧栏面板显示计划与关联运行，计划 / 日历视图显示即将运行，运行卡片链接到对应任务；
  - 单一编辑页控制提示词、时间与高级设置（Skip confirmations 允许可信流程不经确认直接发送 / 发布）。
  - Run now、通知、积分展示：该文未提。

### 1.2 五个关键问题的回答

1. **任务是不是对话？** 分两派，且多数同时支持：
   - 线程派：任务就是会话的子对象，到点回到同一线程（ChatGPT in-chat task；Manus "same task"；Gemini Spark 的计划挂在任务线程下，删线程即删计划）。
   - 会话派：每次运行是独立会话 / 聊天（Claude Cowork 与 Claude Code 每次新会话；ChatGPT standalone；Manus 旧版）。
   - 趋势是把"同线程继续 / 每次新开"做成每个计划的开关，而不是产品级二选一。
2. **列表在哪？** 一级页面 + 会话内面板两处并存：侧栏入口 → 整页列表（ChatGPT "Scheduled"、Cowork "Scheduled tasks"、Manus "Automations"、Claude Code "Routines"、Gemini "Schedules"）；再加线程内的小面板（Gemini tasks panel、ChatGPT 聊天里的任务 pill、Manus 侧栏面板）。没有看到只做弹窗的。
3. **Run now 会不会直播进线程？** 只有 Claude Code 的文档说得明确：Run now 后会话出现在侧栏 Scheduled 分区，可以点进去看并回应权限请求。ChatGPT / Gemini / Manus 只把它定位成"测试"，没有写是否直播。【未证实】
4. **能否回复来调整任务？** Gemini 有 "Edit with Gemini"（在线程里描述改动）；Claude 可以在任意会话里让它改 / 暂停任务，任务还能在运行中改自己的计划；Manus 为单一编辑页；ChatGPT 文档有对应小节（仅读到标题）。
5. **怎么通知？** 通用做法是"未读点（站内收件箱）+ 桌面 / 推送 / 邮件偏好"：ChatGPT 未读指示 + Push / Email；Claude Code 桌面通知 + 补跑通知；Perplexity 邮件开关。Gemini / Cowork / Manus 的帮助页未写。
6. **有没有单次运行的预算 / 上限展示？** 我读到的所有页面里**没有**。出现的都是计数型限额（活跃任务数、并发数）、频率下限（ChatGPT 每小时一次；Claude 云端 1 小时）和"因用量上限而不运行"（Gemini）。Claude Code 的"跳过原因"记录是最接近的做法。

### 1.3 可借鉴的模式（3–6 条）

1. **计划是会话的子对象**：每个定时任务挂在一个会话上；会话右缘有"计划"面板，列出本会话的全部计划；删除会话时明示"将同时删除 / 暂停 N 个计划"（Gemini Spark 的 tasks panel；ChatGPT 删聊天即暂停任务）。
2. **每个计划带一个运行模式开关**：「在本会话继续」/「每次新开独立会话」。需要上下文的（晨报跟进、议程推进）默认前者，互相独立的（逐个检索）默认后者（Manus 运行选项；ChatGPT in-chat vs standalone）。
3. **列表做成一级页"已计划"并兼作收件箱**：Tab 为 全部 / 进行中 / 已暂停 / 已完成；每行 = 名称 + 频率 + "下次运行 x 小时后" + 最近一次结果状态；未读点；顶部"全部标为已读"和搜索（ChatGPT Scheduled）。
4. **详情页动作固定五项**：立即运行（定位为"试跑"，产出落进对应会话并允许直接回复追问）/ 状态开关（进行中·已暂停）/ 编辑 / 运行历史 / 删除；运行历史里把"已跳过"也列出，悬停说明原因（休眠、上次未结束、并发已满、额度已满）（Claude Code 详情页；Gemini 的 Run now 建议用于测试）。
5. **创建与修改走"对话 → 确认卡 → 保存"**：在会话里用自然语言说"每周一早上…"，模型生成含名称 / 频率 / 指令的确认卡，用户点"安排"才生效；非时间类改动用"在线程里描述改动"（Claude "Schedule" 确认步骤；Gemini "Edit with Gemini"）。
6. **限额与预算必须摆在明处**（外部产品普遍缺失，EviMed 的预算化 episode 可以做得更好）：页头显示"活跃 x / 上限"；到上限时"新建 / 恢复"置灰并说明；因预算 / 并发没跑的运行在历史里写明原因；单次运行预算放在编辑表单里，而不是只写在帮助文档里（Gemini 的 50 / 15 限额与"未运行"条件只在帮助页，应用内可见性未证实）。

---

## 2. 主流 Agent 平台里的知识库

### 2.1 逐产品事实

**Google NotebookLM → Gemini Notebook**

- 与知识库（或其子集）对话：来源面板里每个来源可勾选，勾选的才参与回答；官方写法 "Select which sources in your notebook the model should use"，并说"取消选中即可从笔记本里移除该来源（对话范围）"。【一手】[R14][R15] 默认全部勾选、可以在提问里点名某来源缩小范围。【二手·搜索摘要】[R14b]
- 引用：回答里的编号引用，"悬停看完整引文，点击跳到来源里该引文所在的上下文"；"Save to note" 把回答钉到笔记板，表格与可点击的内联引用会保留。【一手】[R15] 来源很短时不逐段引用，只引整篇。【一手】[R14c]
- 文档详情：左侧来源查看器，顶部是自动生成的整篇摘要 "Source Guide"。【一手】[R14c] 摘要下有关键主题列表，点关键主题会开新对话。【二手】[R14b]
- 组织：来源 ≥5 个时可 "Label & Categorize Sources"（自动按主题分组，可增 / 改 / 删标签、在标签间移动）；"+ Add" 添加、"Upload a source" 上传或 Discover 发现新来源。【一手】[R14]
- 版面：中间 Chat，右侧 Studio（音频概览、思维导图、笔记、FAQ / 简报 / 时间线等报告）。【二手】[R14b]；2026-06-08 更新后聊天里会展示得出答案的步骤，并可在聊天中建议来源。【二手】[R16b]
- 对话设置：聊天面板的 "Configure Chat"：风格 Default / Learning Guide / Custom + 回答长度。【一手】[R15]

**Claude Projects**

- 项目 = 项目知识 + 项目指令 + 项目内聊天。知识库在项目主页右侧，点 "+" 上传文档 / 文本 / 代码；"Set project instructions" 设置指令；项目内聊天彼此不共享上下文，除非在项目知识里。【一手】[R17]
- 容量与模式：知识接近上下文上限时自动开启 RAG 模式，容量最高扩到 10 倍，并出现"项目已启用 RAG"的视觉标记；检索时模型调用 "project knowledge search" 工具，用户可看到它在检索。【一手】[R17]；容量进度条的行为官方英文页**未写**（中文版页面称启用 RAG 后进度条消失，来自搜索摘要）。【二手】
- 共享（Team / Enterprise）："Can view" / "Can edit"；项目页签 "Your projects / Organization / Shared with you"。【一手】[R17]
- 引用、文件移除步骤：官方这几页未写。

**ChatGPT Projects**

- 项目 = 聊天 + 参考文件 + 自定义指令；项目内文件对该项目所有聊天可用，聊天里直接附加的文件只作用于该聊天；已有聊天可拖入或 "Move to project"，指令优先于全局自定义指令。【二手·搜索摘要，help.openai.com 403】[R20] 另有项目专属记忆（Project-only memory，2025-08-22 起）。【二手】[R20]

**Perplexity Spaces**

- Space = 线程 + 文件 + 自定义指令；左侧栏 Spaces 图标 → "+ New Space"，默认私有；线程菜单 "Add to Space"；线程与 Computer 任务共用一个列表可按类型筛选；可 pin 线程与文件让所有成员可见；Space 内全文搜索栏；Space 内有 Ask / Computer 切换；Share 授权 View / 贡献者；Pro 每 Space 50 个文件、Enterprise Pro 500、Enterprise Max 5000，文件大小上限 50 MB。【一手】[R19]
- 搜索范围可选 Files / Links / Web + Files + Links；Attach 只给单线程临时加文件。【二手·搜索摘要】

**Gemini Gems**

- 新建 Gem：Gems → "New Gem" → 名称与指令 →（可选）"Knowledge" 下 "Add files"：Upload files / Add from Drive / More uploads → Notebooks（可以挂 NotebookLM 笔记本）；可勾 **"Disable knowledge citations"** 关闭引用；保存前右侧可预览对话；Drive 文件始终用最新版本。【一手】[R18]
- Gems 将在 2026 年 11 月从个人账号移除并迁为 skills。【一手】[R18]

**腾讯 ima（知识库 + 问答 + 笔记）**——以下均为【二手】（官网首页只有导航，无功能说明）[R24]

- 问答面板有"基于全网 / 基于知识库"两种模式（ifanr，2024-11-19）；知识库可放本地文件、公众号文章 / 网页链接、已保存的笔记、ima 内问答结果；文档解读可对库内与本地文件出总结与要点。
- 少数派（2025-06-09）：左侧三个入口（知识库 / 笔记等）；个人知识库 + 共享知识库，共享知识库有"知识库广场"；个人库 30G；AI 内容可一键存笔记、笔记可一键加入知识库；回答能看出基于哪份文件；库内没有答案时提示"根据要求，停止回答"。
- 范围限定：用 `#` 选标签指定文章搜索回复（2026 年教程的转述）。引用是否能点击跳转到原文：**未能证实**；有用户反映引用主要用来定位"哪些文章提到了"，再自己去翻原文。
- 解析进度 / 失败的展示：所读资料均未提。

**Dify**

- 检索测试：知识库左侧栏 "Retrieval Testing" 图标；页面模拟用户查询、试不同检索设置，设置**只在本次测试会话生效**；"Records" 区记录该知识库全部检索事件（测试 + 关联应用的真实检索）。【一手】[R23]
- 应用接入：Chatflow / Workflow 的 Knowledge Retrieval 节点有 "Filter Mode"：Disabled（默认）/ Automatic / Manual；Manual 里 "+Add Condition" 选元数据字段（String / Number / Date），AND / OR 组合；Chatbot 在 "Knowledge" 下方出现 "Metadata Filtering"；在 "Add Features" 打开 "Citation and Attribution" 即可展示引用。检索设置 TopK 默认 3、Score Threshold 默认 0.5。【一手】[R23]
- 分段 / 命中 / 状态：每个命中分段右上角显示匹配分，打开分段看详情，脚注标出来源文档；文档状态分 queuing / parsing / cleaning / splitting / indexing / available(completed) / error / paused，另有 disabled 开关。【二手·搜索摘要】[R23]；论坛有"状态显示 AVAILABLE 但检索测试为空"的个案，提示"已完成"不等于"可检索"。【二手】[R23]

**RAGFlow**

- 数据集详情的默认页是文件列表（File list）：显示解析状态、启用状态、分块数、元数据字段数和文档级操作；Logs 分文档日志与数据集级日志；Retrieval Testing 页用测试问题和可调参数验证召回，改动**不自动保存**，需在 Chat Assistant / Retrieval Agent 里另行应用。【一手】[R22]
- 分块页：每个 chunk 显示正文、关键词、问题、启用状态；工具栏可按关键词搜索、按启用状态筛选、折叠长正文；双击打开 "edit parsing block" 窗口可改 Content / Keywords / Questions / Tags；可新增、停用（保留但不参与召回）、删除；对支持预览的文档，**点击 chunk 文本，文档预览区跳到对应原文位置**。【一手】[R22]

**FastGPT**

- 引用详情（Chunk Reader）：回复下方展示来源；点击引用链接弹出窗口，显示**完整原文并高亮被引用段落**；右上角有引用间翻页与位置（如 "7/10"）；每条引用有排名标签，悬停显示被选中原因与相关度分数构成；有读权限的用户可一键导出整篇被引文档；匿名分享链接下有 "citation content only" 模式，只给外部访客看被引片段；有权限者可在浏览时编辑引用内容，编辑后显示 "Updated" 标签。【一手】[R21]

**Coze 扣子 / Kimi / 豆包 / Notion AI**

- 这四个我**没有拿到一手页面**（docs.coze.cn 搜索无结果，官方页面抓取只返回站点标题）。仅有二手：Coze 建库流程为"创建 → 导入分段 → 向量化索引 → 召回测试 → 挂载 Agent"，导入时可选自动 / 自定义分段并人工微调，检索方式可选全文 / 向量 / 混合 [R25]；Kimi 官方只确认文件问答能力与 100MB 限制，"[1][2] 点击跳原文"仅见第三方博客 [R25]；豆包未找到可信的个人知识库引用说明 [R25]；Notion AI 问答：@ 提及页面 / 团队空间 / 人，"All sources" 下拉筛来源，答案带引用 [R25]。

### 2.2 反复出现的模式（按你要的 a–f）

- **(a) 与知识库 / 子集对话**：两种范围机制并存——"来源勾选"（NotebookLM 复选框）和"输入框里 @ / # 点名"（Notion @、ima `#标签`）；全库默认参与，缩小范围是显式动作；项目型产品（Claude / ChatGPT Projects、Perplexity Spaces）则是"项目内所有聊天共享项目文件，聊天里附件只作用于当前聊天"。
- **(b) 引用回溯**：成熟做法是"悬停预览引文 → 点击在阅读器里滚动并高亮到原文位置"（NotebookLM、FastGPT）；FastGPT 额外给翻页、相关度分解、导出、分享链接下"只给被引片段"。ima / Kimi 的跳转没有一手证实。Gemini Gems 把"引用"做成可整体关闭的开关。
- **(c) 文档详情**：摘要卡（Source Guide）+ 原文阅读器 + 分块列表（RAGFlow：chunk 点击联动原文预览，可启停、编辑、加关键词和问题）+ 试检索（Dify / RAGFlow Retrieval Testing，设置不落库）。"相关问题"一项：Source Guide 的关键主题、RAGFlow 的 chunk "Questions" 字段是最接近的实现。
- **(d) 文件组织**：标签 / 自动分组（NotebookLM 标签）、置顶（Perplexity pin）、个人 vs 共享与角色（Claude "Can view / Can edit"、ima 共享知识库）、元数据字段做过滤（Dify String / Number / Date）。没有看到谁做"文件夹树"作主组织方式。
- **(e) 摄取状态与失败**：Dify 把摄取流水线拆成多个状态并区分"启用开关"；RAGFlow 文件列表带解析状态，另设 Logs 页；Claude 用"RAG 已启用"徽标标明检索模式。普遍缺口：失败原因与重试入口官方页几乎不写，多靠论坛排查。
- **(f) 详情打开方式**：对话内引用 → 弹窗（FastGPT）或同屏阅读器（NotebookLM 左栏来源查看器）；库管理详情 → 整页（RAGFlow 文件列表 → Chunk 页；Dify Retrieval Testing 是侧栏独立页）；项目知识 → 项目主页右侧栏（Claude）。没有谁用"抽屉"做重文档。

### 2.3 可借鉴的模式（3–6 条）

1. **对话范围 = 来源勾选集**：知识库左栏每个来源一个复选框，默认全选，勾选集合就是本次检索范围，输入框上方显示"基于 x 个来源"；输入框内 `@文件` / `#标签` 作为快速限定（NotebookLM 复选框；ima `#`；Notion @）。
2. **引用统一为"悬停整段引文，点击高亮到原文位置"**：阅读器在同屏侧栏打开并滚动到命中位置高亮；阅读器顶部有"‹ 3/8 ›"在同一回答的多条引用间翻页；悬停相关度标签展示分数构成（NotebookLM；FastGPT 引用详情）。
3. **文档详情四件套**：顶部摘要卡 → 原文阅读器 → 分块列表（点击分块联动跳到原文；每块可启用 / 停用，停用的保留但不参与召回）→ "试检索"入口，试检索的参数改动不写回设置（RAGFlow chunk 页；Dify Retrieval Testing）。
4. **摄取状态与"可检索"分开**：状态列用 排队 / 解析中 / 切分 / 索引中 / 已完成 / 失败（带原因与重试）/ 已停用；已完成之后另给"试检索一条"按钮确认能命中，避免"显示完成但检索为空"（Dify 状态集与论坛个案；RAGFlow 文件列表 + Logs）。
5. **容量与检索模式要可见**：项目 / 知识库顶部显示容量条；接近上限自动切到检索模式并打"检索模式"徽标，对话里检索工具调用对用户可见（Claude Projects RAG）。
6. **组织用"标签 + 置顶 + 共享角色"**：来源 ≥5 时提示自动归类；允许置顶；个人 / 共享两层，角色用"可查看 / 可编辑"两档（NotebookLM "Label & Categorize"；Perplexity pin；Claude 共享）。

---

## 3. GEO 工具里的来源 / 引用分析

### 3.1 逐产品事实

**Profound**【一手·产品功能页，非帮助中心，无日期】[R26]

- Citations 列出"每个被监测提示词所引用的每个 URL"，含竞品域名。来源分类：Owned、Competitor、Earned Media、PR Wire、Social、Institution；Owned / Competitor / Custom 由你定义，可覆盖自动分类。
- 引用份额可按平台、主题、提示词拆分；Citation Share 图表给逐日变化；"Watched Pages" 跟踪单个 URL 的引用量随时间变化；排名表对比自家与竞品的份额；可导出 CSV / JSON。
- Pages 视图：每页按引用份额排序，并叠加机器人访问、人类引荐、标签与类别；页面详情是一条时间线（首次发现、告警、周环比引用变化）；引用可按提示词、主题、标签、平台、地区、画像、文本块拆分，各自有份额与排名；还有"被检索到但很少被引用"的筛选、页面内容评分（可读性、新鲜度、结构、信息密度、机器可读性、可回答性）与每项改动的预计得分影响、通过 IndexNow 提交、交给 Agent 去改。
- 术语（官方 glossary）：Citation Share = 指向某域名 / 页面 / 类别的引用占全部引用的百分比；"Pages" = 被引用的具体 URL，区别于域名；Watchlist = 自定义监控页面集。【一手】[R26c] 开发者文档称 Citation Rank 按根域名分组、按份额降序，份额先按模型算再平均。【二手·搜索摘要】

**Peec AI**【一手·docs.peec.ai 与 changelog】[R27]

- 导航：Sources → Domains / URLs（两页分开）；Gap Analysis 在侧栏，也是两页内的开关。
- Domains 页：图表 "Source retrievals over time"（前 5 个域名）与 "Domain type"；Domain movers 四视图 **Top / New / Trending / Losing**；表格列：Source、Domain type（点击可改分类，覆盖项有标记、可重置）、Retrieved、Retrieval rate、Cited、Citation share、Citation rate、Total citations、Gap Score；行首书签 + Bookmarked 页签；类型筛选 "All Domain Types"。分类 7 类：Corporate、Editorial、Institutional、UGC、Reference、Competitor、Other（自家显示为 "You"）。**文档没有写"点域名会打开什么"**。
- URLs 页：趋势图（前 5 个 URL）、URL movers、"Sources Type" 页面类型图（Article / Comparison / Listicle…）、Gap Analysis 开关；表格列：URL、URL Type（可覆盖）、Mentions、Retrievals、Citation Rate、Updated（最近抓取时间）、书签。URL 类型：Homepage、Category Page、Product Page、Listicle、Comparison、Profile、Alternative、Discussion、How To Guide、Article、Other。
- **点击一个 URL 进入详情页**：头部有页面标题、可点的原链接、"View page content" 按钮（显示 Peec 抓到的正文）；概览 KPI（引用率、检索次数、使用该页的提示词数、首次 / 最近出现、较上期变化）；"Retrievals over time" 折线（默认 7 天，含周期对比）；"Retrievals by model" 柱状（按追踪的 AI 模型拆分）；提示词表（哪些提示词检索了它、是否被引用、提示词所属主题）；Brands mentioned；Chats（用过或引用过该 URL 的 AI 回答）。
- 核心概念：Retrieved（AI 访问过）与 Cited（最终回答里明确引用）分开；按来源类型的建议动作：Editorial → 数字公关 / 记者外联，Corporate → 合作与目录，UGC → 真实社区参与 / 创作者合作，Reference → 通过合适渠道更正，自家站点 → 改进结构与可解析性。【一手】[R27c]
- 2026 changelog：2026-06-04 Chats 表可按提及 / 来源数排序；2026-07-06 Domains / URLs 表新增按提及品牌筛选（AND / OR）与 Domains 的 mentions 列；2026-08-03 Domains / URLs 的 Total citations、Citation share 变为可选列。【一手】[R27d]

**Otterly.AI**【一手·help.otterly.ai】[R28]

- Domain Citations 表：列 Domain / Category / Domain coverage，可按覆盖率排序；范围开关 "All domains" / "Me + all competitors"；列头筛选；分类 12 类且**系统分配、不可自定义**（Brand、News/Media、Government/NGO、Social Media、Community/Forum、Education、Encyclopedia、Video、Blogs/Personal Sites、Competitor、Unclassified、Others）；左侧甜甜圈图 "Domain Categories Distribution"，点一类就过滤表格，再点同一类取消。
- Citations 报告：顶部筛选日期 / 标签 / 引擎 / 国家；"Top Winners" / "Top Losers"（各 3 个 URL，与紧邻的等长前一窗口比较）；"Citations Over Time" 趋势；"All cited URLs" 表（引用数、是否提及品牌、域名、域类别、竞品；有搜索、列筛选、排序）。
- **点任一引用 → 右侧 "Citation Details" 面板**：引用指标、品牌提及状态、涉及的竞品、该 URL 出现过的提示词；面板内 "Cited in prompts" 列表带 "Brand Coverage" 列；**再点某个提示词，"Prompt Details" 叠在引用面板之上，保持原位置**。按引擎看结果：引擎筛选在报告顶部，面板里没写按引擎拆分。
- 缺口工作流：Blogs 与 News/Media 类别 + "Not Mentioned" 筛选 = 公关外联目标；Community/Forum 与 Social 同法找 Reddit 等讨论；Brand 类别 = 已被 AI 使用的自有页面。行上星标做个人短名单，三个视图同步、仅自己可见。

**Semrush AI Visibility Toolkit**【一手·KB 1598，仅部分】[R29]

- Competitor Research 报告里把视图切到 **Sources**：列出"被分析品牌出现在 AI 回答里时，AI 引用的外部域名"；搜索栏可查具体外部域名；**Missing** 筛选 = 竞品被提及而你的品牌未被提及时被引用的外部域名（官方称外联 / 内容机会），对应指标 Missing Sources。KB 页**没写**表格列、域名下怎么看具体 URL、按引擎筛选。
- 术语（Semrush 指标页，搜索摘要）：Cited Sources、Source Opportunities、Cited Pages。博客教程（二手）称点开域名行可展开具体引用页面，并建议按"出现的提示词数、域名自然流量、被引 URL 数"排序。【二手·搜索摘要】

**Ahrefs Brand Radar**【一手·Academy 页，仅部分】[R30]

- Cited domains 报告里点你域名下方的 "Pages" 数字，进入被引用页面列表；可逐个 AI 平台查看引用模式；过滤器支持 reddit.com 页面、"AI 回答包含你品牌"、纳入 / 排除竞品域名等。该页**没写**列定义、图表、能否看到引用某页的具体提示词 / 回答。
- 2026-04 更新（Ahrefs 博客，搜索摘要）：新增引用漏斗 "Cited in"（域被引用的回答数）与 "Found in"（页面被找到，无论是否被引），以及 "Found but not cited"；引用图有 Found in（回答数随时间）与 Position（平均引用位置随时间）两种模式。【二手·搜索摘要】[R30b]

**Scrunch**【一手·help center】[R31]

- Citations 页每行是一个被引 URL；"Group by Domain"（默认）/ "Group by URL" 切换；列含 Influence Score（= 引用一致性 % × 提示词数）与 Presence（Yes / No：你的品牌是否出现在**被引页面本身**，不代表出现在 AI 回答里）。
- 筛选：Platform、Owner（Owned / Competitor / Third Party）、Prompt Topic（按触发它的提示词主题分）与 Citation Topic（按被引页面内容主题分）。
- **点域名或 URL 打开详情**：引用它的提示词、引用一致性与提示词数、所选时段引用频率趋势图、分平台统计，可再按平台 / 所有者 / 主题筛选；导出 "Detailed"（逐提示词）或 "Summary"（与界面一致）。默认时间范围 12 周（how-to 页，搜索摘要）。

**AthenaHQ**：未找到官方帮助文档，仅有评测（二手）：记录每个提示词的完整回答并映射其引用，"Source Intelligence" 识别 AI 引用的具体 URL，有"品类被引域名"面板，竞品在高意图提示词上上升时给出告警并显示关联来源。【二手】[R32]

### 3.2 点击一个被引来源后会打开什么

| 产品 | 点击域名 | 点击 URL |
|---|---|---|
| Profound | 官方页未写 | 页面详情：时间线 + 按提示词 / 平台 / 地区 / 画像 / 文本块拆分的份额与排名 + 内容评分建议【一手】 |
| Peec | 未写（Domains 与 URLs 是两个独立页面） | **整页详情**：KPI、检索趋势、按模型柱状、提示词表、提及品牌、相关 AI 回答、"View page content"【一手】 |
| Otterly | 表内按类别 / 域名过滤 | **右侧叠层面板**：Citation Details → Cited in prompts → Prompt Details 逐层叠加【一手】 |
| Scrunch | 详情：引用它的提示词、趋势、分平台统计 | 同左（"Group by URL" 视图）【一手】 |
| Semrush | 展开行看被引页面（二手） | KB 未写 |
| Ahrefs | 点 "Pages" 数字进入页面列表 | 未写 |

### 3.3 可借鉴的模式（3–6 条）

1. **域名 → URL 两级结构，用"按域名 / 按 URL 分组"切换，不拆成两套页面**（Scrunch）；或明确两张表分开但互相下钻（Peec）。EviMed 的来源面板建议默认按域名，行内数字可点进该域名的被引页面。
2. **点来源打开右侧叠层面板，层层叠加但保持原位置**：来源详情 → 引用它的提示词 / 回答 → 单条回答详情，各层可返回（Otterly Citation Details → Prompt Details）。需要长内容的"来源详情页"才用整页。
3. **来源详情的固定内容**：原页链接 + "查看抓取正文"按钮；KPI 行（引用率、检索次数、涉及提示词数、首次 / 最近出现、较上期变化）；趋势（默认 7 天并带周期对比）；按引擎柱状图；引用它的提示词表；同页出现的品牌；对应的 AI 回答列表（Peec URL 详情页）。
4. **来源类型 chip + 可覆盖**：固定一套类型（自有 / 竞品 / 编辑媒体 / 机构 / UGC / 参考 / 其他），自动分类可由用户改，覆盖项带标记并可"重置为自动"（Peec、Profound）。EviMed 需要把类型映射到医学场景（指南、期刊、监管、学会、患者社区…），这一映射是我们自己的设计，不是外部产品原样可抄。
5. **"被读取 / 被引用"拆成两列**，并提供"被读取但未被引用"筛选来定位内容问题（Peec Retrieved vs Cited；Ahrefs "Found in" vs "Cited in"；Profound "retrieval candidates but rarely cited"）。
6. **机会视图 + 动作建议 + 个人收藏**：筛选"竞品被提及而我方未被提及"（Semrush Missing、Otterly Not Mentioned、Peec Gap Score）；按来源类型直接给建议动作；Top / New / Trending / Losing 或 Winners / Losers（对比等长前一窗口）；星标短名单仅自己可见；导出分"明细 / 汇总"两种（Scrunch、Otterly、Peec）。

---

## 4. 对话输入框底部布局约定

### 4.1 实测与逐产品事实

**Gemini（网页，未登录，【实测】2026-10-08，视口 1280×800；截图留在 `.playwright-mcp/gemini-chat-bottom.png` 与 `gemini-chat-bottom2.png`）**

- 输入框是居中的胶囊：宽 660、高 64，位于 992 宽的内容列中；**输入框内部**：最左 "+" 按钮（可访问名 "Upload & tools"，32×32）、中间文本框 "Ask Gemini"、右侧模式选择器（"Open mode picker, currently Flash-Lite"，40 高）与麦克风（"Dictate (^⇧D)"，32×32）。输入框上方、框内都**没有**常驻 chip；工具都收进 "+" 菜单。
- 输入框正下方只有一行小字免责：空状态是 "Google Terms and the Google Privacy Policy apply. Gemini is AI and can make mistakes."，进入对话后精简为 "Gemini is AI and can make mistakes."；该行高 17px，底边距视口底 16px。
- 对话态消息区：消息滚动容器（`infinite-scroller`）**止于输入框块上方**（不是铺满整屏被输入框遮住），容器 `padding-bottom: 20px`；最后一段文字下方先有一行消息操作（重新生成、复制、更多 "⋯"，约 24px），其后再到容器底边；滚到底时最后一行文字底边距容器底边 56px。未登录态在输入框上方多出一块 "Sign in to connect…" 横幅（88px 高，距输入框 12px），不属于常态布局。
- 内容滚入输入框区域时，底边有渐隐，而不是被硬切（截图可见第 9 条文字在横幅上沿渐淡）。
- 版面变化史（【二手】）：2025-05 移动端 "+" 旁有 Research / Canvas 胶囊；2025-09 引入 Tools 菜单并撤掉独立 chip；2026-03-24 网页端把 Tools 收进 "+" 菜单，输入框回到胶囊形，左侧模型选择器带 Fast / Thinking / Pro 图标，右侧是麦克风（输入后变为发送按钮）。[R39]

**ChatGPT（网页；chatgpt.com 抓取 403，以下为第三方对真实界面的探测，【二手】）**

- 2026-06-15 的开发者探测日志 [R35]：输入框 "+" 的可访问名是 "Add files and more"，菜单项为 "Add photos & files"、"Recent files"、"Create image"、"Deep research"、"Web search"、"More"、"Projects"，其中 "Create image" / "Deep research" / "Web search" 三项是单选项（radio）；选中 Web search 后，**输入框内出现一个 "Search, click to remove" 的 pill**（按一次 Esc 关菜单，再按一次移除 pill）；模型按钮在输入框内（"Instant"），菜单为简化的 Intelligence 选择器：Instant / Medium / High / Extra High / Pro Extended / GPT-5.5 子菜单。
- Deep research 模式下输入框占位文案变为 "Get a detailed report."，输入框内多出 "Apps"、"Sites" 两个下拉；输入框**下方**出现 "Suggested / Reports" 页签与示例提示；提交后输入框**上方**出现研究计划卡（Edit / Cancel / Start，约 60 秒倒计时自动开始）。[R35]
- 2026-04（聚合站，二手）网页端把选模型移入输入框；2026-06-22 超过 1 万字符的长粘贴自动转为附件，让输入框保持干净。[R40b]
- "ChatGPT can make mistakes…" 免责行位置：没有拿到可信来源，**未验证**。

**Claude.ai（网页，需登录，无法实测）**

- 官方帮助：所选模型与 effort 显示在**发送按钮旁**；点模型名打开菜单："More models"、"Effort"（Low / Medium / High / Extra high / Max），悬停 Effort 出现 "Thinking" 开关；无 effort 的模型直接在菜单里有 "Extended" 开关。【一手】[R33] 旧版把思考开关放在输入框左下的 "Search and tools" 按钮里（二手教程）。"+" 按钮用于附加文件（二手教程）。免责行 "Claude is AI and can make mistakes." 的位置：**未验证**。
- 上下文用量：搜索未发现 claude.ai 网页端有原生"对话长度"仪表（一家浏览器扩展厂商声称没有，利益相关）。【二手】

**Claude Code Desktop（官方文档）【一手】[R34]**

- 首条消息前在**输入区**配置四件事：Environment（Local / Cloud / SSH / WSL）、项目文件夹、模型（下拉，**在发送按钮旁**）、权限模式（选择器，**在发送按钮旁**）；"+" 按钮在输入框旁，菜单含文件附件 / skills / connectors / plugins；环境下拉也在输入框里。
- **用量环**：模型选择器旁的 usage ring，点击展开"当前上下文窗口用量 + 本周期套餐用量"；上下文按会话，套餐用量跨所有 Claude Code 界面共享。
- 运行中：停止按钮可立即中断；也可以直接输入纠正并回车，"不中断正在执行的动作"，Claude 在当前动作结束后读取并在下一步前调整。回复后输入框为空时，可显示一条灰色的"建议的下一条提示"，Tab / 右箭头接受。快捷键 Cmd+Shift+M 打开权限模式菜单、Cmd+Shift+E 打开 effort 菜单。会话里有 PR 时底部出现 CI 状态条。
- 已知问题（用户 issue 镜像，【二手】[R38]）：2026-09 有报告称环的填充反映的是 5 小时套餐用量而非会话上下文，上下文占比要点开才看得到；2026-06 有"新会话显示 94%、明细合计约 17%"的 bug。

**Codex 桌面应用**

- 官方文档【一手】[R36]：新建对话视图里 **"Worktree" 选项在输入框下方**；"**在输入框下方**选择作为 worktree 基础的 Git 分支"；Add 菜单示意含 "Files and folders"、"Attach Google Chrome"、"Goal"、"Plan mode"；权限选择器存在（含自动审核选项，来自搜索摘要，【二手】）。
- 上下文用量"甜甜圈"：2026-05-21 有 Windows 版本丢失该指示的 issue；OpenAI 社区回复称团队决定把它恢复到**输入框下方**原位；2026-06-22 另有"重开应用后显示 0%、发消息后恢复"的 bug 报告。【二手】[R37]

**Perplexity**：官方帮助中心多篇 403，仅有搜索摘要【二手·低置信】：模式菜单附在查询输入框上（Best / Pro Search / Reasoning / Research，Labs 已并入 "Create files and apps" / Assets），来源选择与附件和模式、模型选择在同一区域；聚焦模式在查询框下方（各来源列表不一致）。[R42] 因此 Perplexity 输入框布局**不作为设计依据**。

### 4.2 约定对照（能确认的部分）

| 项 | Gemini（实测） | ChatGPT（二手） | Claude（一手） | Claude Code / Codex（一手+二手） |
|---|---|---|---|---|
| 工具 / 模式入口 | 框内最左 "+"，菜单承载全部工具 | 框内 "+"；选中工具成框内可移除 pill | 框内 "+"（二手）；工具开关在模型菜单内 | "+" 在输入框旁；技能 / 连接器 / 插件进 "+" 菜单 |
| 模型 / 推理参数 | 框内右侧，紧邻麦克风 | 框内的模型按钮（Intelligence 选择器） | 发送按钮旁，菜单含 Effort 与 Thinking | 发送按钮旁（模型、权限模式、effort 快捷键） |
| 输入框下方 | 一行小字免责 | 未验证 | 未验证 | Codex：Worktree 与分支选择在框下；Claude Code：环境 / 文件夹在输入区内 |
| 用量 / 上下文指示 | 无 | 无 | 网页端未发现 | 小圆环 / 甜甜圈，紧邻模型选择器或位于框下，点击展开 |
| 消息区底部 | 容器止于输入框上方，padding-bottom 20px，消息操作行 + 渐隐 | 未测 | 未测 | 未测 |

### 4.3 可借鉴的模式（3–6 条）

1. **工具 / 模式 chip 放进输入框内的工具栏行，选中后变成框内可移除 pill**；常驻 chip 不放在框外（Gemini 把全部工具收进 "+"；ChatGPT 的 "Search, click to remove" pill）。EviMed 的"证据检索 / 深度研究 / 数据集"等模式用同一套：未选时只露 "+"，选中后在框内左侧出 pill。
2. **参数选择器靠右、紧邻发送按钮**：模型、推理强度、权限放同一组，点开是一个菜单，菜单内再分 Effort / Thinking 子项；不要散落在框上方（Claude 的模型菜单；Claude Code 发送键旁的模型与权限模式；Gemini 框内右侧模式选择器）。
3. **"范围类"选项放在输入框下方一行**：项目 / 分支 / 工作区这类开始会话前决定、开始后很少改的选项，放在输入框外下方；会话开始后可折叠（Codex 的 Worktree 与分支在输入框下方）。EviMed 里"知识库范围 / 项目"属于这一类。
4. **用量 / 上下文做成紧邻模型选择器的小圆环，点击展开面板，且一个环只表达一种量**：展开面板里把"本会话上下文"与"账户额度"分两行；环的填充必须对应用户预期的那个量（Claude Code 的环；Claude Desktop issue 暴露出"环填充的是套餐用量却被当作上下文"的误解；Codex 甜甜圈的丢失与恢复说明用户依赖它）。
5. **底部区域只留两样东西：框下一行小号提示 + 留白规则明确的消息区**：框下固定一行（Gemini 17px 高，距视口底 16px），EviMed 可放"AI 可能出错，请核对证据来源"，不叠加其他控件；消息滚动容器止于输入框块上方（同级关系，非覆盖），保留 20px 底部 padding，最后一条回答下方先放消息操作行（重试 / 复制 / 更多）再留白，靠近输入框一侧做渐隐遮罩而不是硬切（以上数值只来自 Gemini 一个产品的单一状态；若输入框是覆盖式，padding-bottom 应取 输入框高度 + 20px 以上）。
6. **运行中仍可输入纠正**：发送不中断当前动作，在下一步前生效；停止是另一个独立按钮；输入框为空时可显示灰色"建议的下一条"，Tab 接受（Claude Code Desktop）。

---

## 证据缺口（请设计评审时知晓）

- ChatGPT / Perplexity 的网页界面无法自动化访问，输入框布局只有第三方探测与摘要；claude.ai 需要登录，输入框底部布局只有帮助页文字描述。上面第 4 节的尺寸数值**仅来自 Gemini 未登录网页的一次实测**，不能外推为"行业标准"。
- Coze、Kimi、豆包、Notion AI 的知识库没有一手页面；ima 官方没有公开界面说明，全部为媒体评测。
- Perplexity Tasks、ChatGPT Tasks 帮助页（403）与 Gemini 旧版 Scheduled Actions 只有二手。
- 没有任何产品的资料披露"单次运行预算 / 成本"在任务列表里的展示；这是 EviMed 可以自己定义的部分。
- Peec 的 Domains 页点域名的行为、Semrush 域名下钻、Ahrefs 引用页的提示词下钻，官方页都没写。

---

## 参考文献（访问日期均为 2026-10-08）

### 1 定时任务
- [R1] OpenAI, "Scheduled tasks"（ChatGPT 桌面端 / Codex 统一文档，无日期；正文提到 GPT-5.5 于 2026-10-14 退役）— [https://learn.chatgpt.com/docs/automations?surface=app](https://learn.chatgpt.com/docs/automations?surface=app)
- [R2] OpenAI, "Scheduled tasks" walkthrough（无日期）— [https://developers.openai.com/training/walkthroughs/scheduled-tasks](https://developers.openai.com/training/walkthroughs/scheduled-tasks)
- [R3] OpenAI Help Center, "Tasks in ChatGPT"（直接抓取 403，仅搜索摘要）— [https://help.openai.com/en/articles/10291617-tasks-in-chatgpt](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt)
- [R4] Engadget, "ChatGPT now has a hub for scheduled tasks"（2026-06-17）— [https://www.engadget.com/2196844/chatgpt-now-has-a-hub-for-scheduled-tasks/?rand=26687](https://www.engadget.com/2196844/chatgpt-now-has-a-hub-for-scheduled-tasks/?rand=26687)；[R4b] Gigazine（2026-06-19）— [https://gigazine.net/gsc_news/en/20260619-chatgpt-scheduled-tasks/](https://gigazine.net/gsc_news/en/20260619-chatgpt-scheduled-tasks/)；The Decoder（2026-06-20）— [https://the-decoder.com/chatgpt-keeps-creeping-toward-becoming-your-ai-personal-assistant-with-new-scheduled-task-controls/](https://the-decoder.com/chatgpt-keeps-creeping-toward-becoming-your-ai-personal-assistant-with-new-scheduled-task-controls/)
- [R6] Claude Help Center, "Schedule recurring tasks in Claude Cowork"（页面仅显示 "Updated yesterday"）— [https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork](https://support.claude.com/en/articles/13854387-schedule-recurring-tasks-in-claude-cowork)
- [R7] Claude Code Docs, "Schedule recurring tasks in Claude Code Desktop"（无日期）— [https://code.claude.com/docs/en/desktop-scheduled-tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks)
- [R8] Google Gemini Help, "Create & manage schedules for tasks in Gemini Spark"（©2026，无日期）— [https://support.google.com/gemini/answer/17094710](https://support.google.com/gemini/answer/17094710)
- [R9] Gemini Scheduled Actions（2025-06 上线，二手）— [https://www.digitalcitizen.life/gemini-scheduled-actions-how-to-automate-tasks-with-google-gemini/](https://www.digitalcitizen.life/gemini-scheduled-actions-how-to-automate-tasks-with-google-gemini/)
- [R10] TestingCatalog, "Perplexity adds scheduled tasks…"（2025-06-13，二手）— [https://www.testingcatalog.com/perplexity-adds-scheduled-tasks-feature-for-pro-and-enterprise-users.md](https://www.testingcatalog.com/perplexity-adds-scheduled-tasks-feature-for-pro-and-enterprise-users.md)；[R10b] Guideflow（2026，二手）— [https://www.guideflow.com/tutorial/how-to-enable-scheduled-tasks-notification-in-perplexity](https://www.guideflow.com/tutorial/how-to-enable-scheduled-tasks-notification-in-perplexity)
- [R11] Manus Docs, "Automations"（无日期）— [https://manus.im/docs/automations.md](https://manus.im/docs/automations.md)
- [R12] Manus blog, "Scheduled Tasks 2.0"（"Monday, May 18"，年份未印，推断 2026）— [https://manus.im/en/blog/manus-schedules](https://manus.im/en/blog/manus-schedules)
- [R13] OpenAI Academy, "Codex automations"（2026-04-23，直接抓取 403，仅搜索摘要）— [https://openai.com/academy/codex-automations](https://openai.com/academy/codex-automations)

### 2 知识库
- [R14] Google Help, "Create a notebook in Gemini Notebook"（无日期）— [https://support.google.com/notebooklm/answer/16206563](https://support.google.com/notebooklm/answer/16206563)；[R14b] NotebookLM 来源 / 引用 / Source Guide 二手综述 — [https://freeacademy.ai/lessons/notebooklm-setup-sources](https://freeacademy.ai/lessons/notebooklm-setup-sources)；[R14c] Google Help（Gemini Notebook 来源与 Source Guide 页）— [https://support.google.com/notebooklm/answer/16215270](https://support.google.com/notebooklm/answer/16215270)
- [R15] Google Help, "Use chat in Gemini Notebook"（无日期）— [https://support.google.com/notebooklm/answer/16179559](https://support.google.com/notebooklm/answer/16179559)
- [R16] Google Blog, "NotebookLM is now Gemini Notebook"（2026-07-16）— [https://blog.google/innovation-and-ai/products/gemini-notebook/notebooklm-gemini-notebook/](https://blog.google/innovation-and-ai/products/gemini-notebook/notebooklm-gemini-notebook/)；[R16b] 2026-06-08 更新（二手，抓取失败仅搜索摘要）— [https://techcrunch.com/2026/06/08/notebooklms-new-update-will-help-you-build-source-repository-from-chat/](https://techcrunch.com/2026/06/08/notebooklms-new-update-will-help-you-build-source-repository-from-chat/)
- [R17] Claude Help Center：What are projects — [https://support.claude.com/en/articles/9517075-what-are-projects](https://support.claude.com/en/articles/9517075-what-are-projects)；How can I create and manage projects — [https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects](https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects)；RAG for projects — [https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects](https://support.claude.com/en/articles/11473015-retrieval-augmented-generation-rag-for-projects)（均无日期）
- [R18] Google Gemini Help, "Use Gems in Gemini Apps"（无日期；含 2026-11 起 Gems 迁为 skills 的提示）— [https://support.google.com/gemini/answer/15146780](https://support.google.com/gemini/answer/15146780)
- [R19] Perplexity Help Center, "Spaces"（无日期）— [https://intercom.help/perplexity-ai/en/articles/10352961-spaces](https://intercom.help/perplexity-ai/en/articles/10352961-spaces)
- [R20] OpenAI Help Center, "Projects in ChatGPT"（直接抓取 403，仅搜索摘要）— [https://help.openai.com/en/articles/10169521-projects-in-chatgpt](https://help.openai.com/en/articles/10169521-projects-in-chatgpt)
- [R21] FastGPT Docs, "Knowledge Base Chunk Reader"（无日期）— [https://doc.fastgpt.cn/en/guide/chat/quoteList](https://doc.fastgpt.cn/en/guide/chat/quoteList)
- [R22] RAGFlow Docs：chunk 管理 — [https://ragflow.io/docs/chunk_parsing_results_and_knowledge_fragment_management](https://ragflow.io/docs/chunk_parsing_results_and_knowledge_fragment_management)；dataset overview — [https://ragflow.io/docs/dataset_overview](https://ragflow.io/docs/dataset_overview)（无日期）
- [R23] Dify Docs：Test retrieval — [https://docs.dify.ai/en/use-dify/knowledge/test-retrieval](https://docs.dify.ai/en/use-dify/knowledge/test-retrieval)；Integrate knowledge within application — [https://docs.dify.ai/en/cloud/use-dify/knowledge/integrate-knowledge-within-application.md](https://docs.dify.ai/en/cloud/use-dify/knowledge/integrate-knowledge-within-application.md)；文档索引状态 API（仅搜索摘要）— [https://docs.dify.ai/en/api-reference/documents/get-document-indexing-status](https://docs.dify.ai/en/api-reference/documents/get-document-indexing-status)
- [R24] 腾讯 ima（二手）：ifanr（2024-11-19）— [https://www.ifanr.com/1606390](https://www.ifanr.com/1606390)；少数派（2025-06-09）— [https://sspai.com/post/99985](https://sspai.com/post/99985)；官网 — [https://ima.qq.com/](https://ima.qq.com/)
- [R25] 未取得一手页面的产品（二手，仅搜索摘要）：Coze 教程 — [https://juejin.cn/post/7517486807891623988](https://juejin.cn/post/7517486807891623988)；Kimi 开放平台文件问答 — [https://platform.kimi.ai/docs/guide/use-kimi-api-for-file-based-qa.md](https://platform.kimi.ai/docs/guide/use-kimi-api-for-file-based-qa.md)；Notion AI Q&A 综述 — [https://wisechecker.com/notion-ai-q-and-a-ask-questions-across-pages/](https://wisechecker.com/notion-ai-q-and-a-ask-questions-across-pages/)

### 3 GEO
- [R26] Profound：Citations — [https://www.tryprofound.com/features/answer-engine-insights/citations](https://www.tryprofound.com/features/answer-engine-insights/citations)；Pages — [https://www.tryprofound.com/features/pages](https://www.tryprofound.com/features/pages)；[R26c] Glossary — [https://help.tryprofound.com/articles/9363559589-profound-glossary](https://help.tryprofound.com/articles/9363559589-profound-glossary)（均无日期）
- [R27] Peec AI Docs：Domains — [https://docs.peec.ai/domains.md](https://docs.peec.ai/domains.md)；URLs — [https://docs.peec.ai/urls.md](https://docs.peec.ai/urls.md)；[R27c] Understanding sources — [https://docs.peec.ai/understanding-sources](https://docs.peec.ai/understanding-sources)；[R27d] Changelog（含 2026-06-04 / 07-06 / 08-03）— [https://peec.ai/changelog](https://peec.ai/changelog)
- [R28] Otterly.AI Help：Domain citations — [https://help.otterly.ai/what-insights-can-i-gain-from-domain-citations-analysis](https://help.otterly.ai/what-insights-can-i-gain-from-domain-citations-analysis)；Citations report — [https://help.otterly.ai/how-can-citations-report-help-you-analyze-your-content-gaps](https://help.otterly.ai/how-can-citations-report-help-you-analyze-your-content-gaps)（无日期）
- [R29] Semrush KB, Competitor Research report — [https://www.semrush.com/kb/1598-competitor-research-report](https://www.semrush.com/kb/1598-competitor-research-report)（无日期）
- [R30] Ahrefs Academy, "Cited Domains & Cited Pages"（无日期）— [https://ahrefs.com/academy/how-to-use-brand-radar/cited-domains](https://ahrefs.com/academy/how-to-use-brand-radar/cited-domains)；[R30b] Ahrefs blog, 2026-04 更新（仅搜索摘要）— [https://ahrefs.com/blog/?p=197438](https://ahrefs.com/blog/?p=197438)
- [R31] Scrunch Help Center, "Understanding the Citations tab"（无日期）— [https://helpcenter.scrunchai.com/en/articles/11944877-understanding-the-citations-tab-in-scrunch](https://helpcenter.scrunchai.com/en/articles/11944877-understanding-the-citations-tab-in-scrunch)
- [R32] AthenaHQ 评测（二手，竞品撰写，未找到官方文档）— [https://www.tryanalyze.ai/blog/athenahq-ai-review](https://www.tryanalyze.ai/blog/athenahq-ai-review)

### 4 输入框底部
- [R33] Claude Help Center, "Change the model, effort, and extended thinking settings"（页面仅显示 "Updated today"）— [https://support.claude.com/en/articles/8664678-change-the-model-effort-and-extended-thinking-settings](https://support.claude.com/en/articles/8664678-change-the-model-effort-and-extended-thinking-settings)
- [R34] Claude Code Docs, "Desktop application"（无日期）— [https://code.claude.com/docs/en/desktop](https://code.claude.com/docs/en/desktop)
- [R35] agbrowse devlog, "ChatGPT composer tools live probe — PR #78"（2026-06-15，第三方探测，二手）— [https://cdn.jsdelivr.net/npm/agbrowse@0.1.16/devlog/_fin/260615_chatgpt_composer_tools_live_probe.md](https://cdn.jsdelivr.net/npm/agbrowse@0.1.16/devlog/_fin/260615_chatgpt_composer_tools_live_probe.md)
- [R36] OpenAI Docs：Git worktrees — [https://learn.chatgpt.com/docs/environments/git-worktrees.md](https://learn.chatgpt.com/docs/environments/git-worktrees.md)；Features — [https://learn.chatgpt.com/docs/features](https://learn.chatgpt.com/docs/features)（无日期）
- [R37] Codex 桌面上下文指示（二手）：GitHub issue #23794 镜像（2026-05-21）— [https://upd.dev/openai/codex/issues/23794](https://upd.dev/openai/codex/issues/23794)；OpenAI 社区帖 — [https://community.openai.com/t/why-doesnt-the-dialogue-show-the-context-size-anymore/1381853](https://community.openai.com/t/why-doesnt-the-dialogue-show-the-context-size-anymore/1381853)
- [R38] Claude Desktop 用量环 issue 镜像（2026-09，二手）— [https://claudeissues.com/issue/92475-desktop-app-status-bar-ring-no-longer-reflects-the-sessions-context-usage](https://claudeissues.com/issue/92475-desktop-app-status-bar-ring-no-longer-reflects-the-sessions-context-usage)
- [R39] 9to5Google, Gemini 网页端输入框重设计（2026-03-24）— [https://9to5google.com/2026/03/24/gemini-plus-menu-redesign-early-2026/](https://9to5google.com/2026/03/24/gemini-plus-menu-redesign-early-2026/)
- [R40b] ChatGPT release notes 聚合（2026，二手；本次抓取的条目中没有输入框相关项，输入框相关两条来自搜索摘要）— [https://releases.sh/openai/chatgpt.md](https://releases.sh/openai/chatgpt.md)
- [R41] 实测：Gemini 网页端（未登录）— [https://gemini.google.com/app](https://gemini.google.com/app)，2026-10-08，视口 1280×800
- [R42] Perplexity Help Center, "What is Research mode?"（仅搜索摘要，低置信）— [https://www.perplexity.ai/help-center/en/articles/10738684-what-is-research-mode](https://www.perplexity.ai/help-center/en/articles/10738684-what-is-research-mode)

<!-- G DONE -->
