# E — Tool entry, long-run UI, visual language and navigation (web research, 2026-09-20)

Produced by a read-only sub-investigation for `../2026-09-20-产品现状根因分析与一次性整改方案.md`. File and line references are as of commit 70683e97a.

**Caveats.** OpenAI's help centre refused fetches, so the ChatGPT facts come from secondary sources. Yuanbao and Coze evidence is thin. [35] is a third-party reconstruction of DeepSeek's mobile app. Kernel seat names, the 280/56 sidebar constants and the contrast figures come from this repo's own notes on the pinned 0.1.5-rc.2 client, not the web.

## 1. Tool entry
The field has converged on one pattern: **pill under the composer → removable chip armed inside the same composer → placeholder rewritten → starters below swap.**
- **Manus:** mode chips sit under the bar. A click arms an in-bar pill, the placeholder becomes "Describe your presentation topic", and templates and sample prompts appear. Clearing the mode keeps the prompt [1].
- **Kimi:** outcome pills under the bar. A click adds a chip, rewrites the placeholder and shows case galleries [2].
- **ChatGPT:** a + menu leads to a removable chip; the empty state shows three starter pills; Deep Research arms with its own placeholder [3].
  - GPTs carry a name, picture and conversation starters [4].
  - `@` summons a GPT mid-thread as a "Talking to X" tab above the box, with an X to remove it [5].
- **Claude:** one + menu. Skills load by description or `/name` [6]. It is criticised for "no in-card armed-state feedback" [7]. Research shows a blue indicator that toggles off [8].
- **Doubao:** the skill bar on the new-chat page is ordered by usage and pinnable [9]. A skill inserts a tag plus a template with editable slots into the same input [10].
- **Yuanbao:** stackable 深度思考/深度搜索 switches in the input [11].
- **Coze Space:** 探索/规划 modes and expert agents on the home page [12].
- **Genspark:** agent tiles under the home box. Each opens its own page with the same prompt box and a template library beneath [13].
- **Perplexity:** Focus modes were replaced by a mode selector on the bar [14]; Spaces became Projects [15].
- **Evidence tools are task-first:**
  - Elicit's home offers six jobs, each started from a question or upload [16].
  - OpenEvidence is one ask bar with example questions, "." for saved prompts, and three sections in all [17][18].
  - Consensus is a search box plus the Consensus Meter and study filters [19].

## 2. Long runs
- **Right panel shows live work, then the result:**
  - Manus's Computer shows browser, terminal and editor; results land there; replay is available [20].
  - Coze Space uses tabs 实时跟随/浏览器/文件/任务, and planning mode confirms steps first [12].
  - Devin's Progress tab unifies every step and offers a `/btw` side chat [21].
  - Cursor gives each background agent a status and a shareable link [22].
- **OpenAI Deep Research:** a live Activity and Sources sidebar [23]. Scope is adjustable mid-run. The report opens in a fullscreen viewer with TOC left and citations right, exportable as MD/Word/PDF [24].
- **Gemini:** plan → Edit plan / Start research, with "Show thinking" and "Sites browsed". You can leave and be notified. The report opens in a Canvas panel [25][26].
- **Kimi:** a clarification step with a skip button, live keywords and URLs, 10–25 minutes, and a text plus HTML report [27]. Doubao delivers a document or a web page [28].
- **Claude** promotes deliverables to a split-pane artifact [29]. **Perplexity** keeps collapsed steps inline, has Answer/Links tabs, and offers "Check sources" on selected text [30].
- **Verification:** in Elicit you click a cell and flip through supporting quotes in context [31].
- **Sub-agents:** a DSH community theme lists them with name, elapsed time, tokens, a progress bar and click-through [32].
- **Pattern writing agrees:** show the plan as a checklist outside the thread, and give tasks their own surface with status cards and completion notices [33].

## 3. Visual language
- **DeepSeek layout:** a centred card on a blank canvas, a tier toggle above it, and DeepThink/Search chips inside the card with a highlighted armed state [34].
- **Reconstructed DeepSeek values [35]:**
  - White canvas; surfaces #F5F6F8/#ECEEF2; divider #E4E6EB; text #1A1B1E/#6A6B70/#9A9BA0.
  - One accent, #4D6BFE, used only on the mark, the user bubble, active toggles and send.
  - Body 15/1.6; composer radius 25; pills 999.
  - Flat surfaces with hairlines; shadow only on floating menus.
- **DSH client:**
  - `--dsw-alias-*` tokens are recoloured via `ctx.theme.overrideTokens` [36].
  - Components hard-code 11/12/13/14/16/20/24 px [37].
  - A community harmonizer normalizes to 32 px capsule buttons, a 44 px tab bar and a 748 px column [38].
- **Anthropic's host guidance [39]:** three sizes, two weights, host tokens for structure, monochrome outlined icons, 0.5 px borders, radii 4–12, skeletons rather than spinners, and never replicate the chat input.
- **CJK:** Ant Design uses 14/22, a system-first stack and weights 400/500 [40]. The W3C Chinese layout requirements put line gap at 50–100 % of size (line-height 1.5–2.0) and treat 密排 as no tracking [41].
- **Clinical:** "clarity matters more than beauty", with repeated patterns [42].

## 4. Navigation
- ChatGPT piled up surfaces (Projects, GPTs, Library, Apps, Codex, Pulse…), folded them into Pinned/More, and drew complaints [43].
- Manus has four: new task, history, knowledge, settings [20].
- Memory sits in settings: ChatGPT → Personalization [44]; Claude → Settings > Memory, separate per project [45].
- Manus schedules live in Settings [46] and in the composer's More menu [1].
- Perplexity makes optional sidebar items a user toggle [47].

## Recommendations
**(a) Home.**
- Order: greeting (24/600) → the one composer → four category tabs → tool grid → recent work. Delete the starter cards.
- Show 8 cards ordered by this user's usage, pinnable; 「全部工具」 opens the rest.
- Card: mono icon, name (14/600), one-line promise (13), meta 「约 30 分钟 · 报告 + 证据表」.
- Categories: 证据与综述 / 药物与安全 / 数据与方法 / 写作与评审.
- Recent work: five rows of title, tool chip, status dot and time, with running items first.
- Typing without a tool stays a plain answer.

**(b) Tool landing.**
- Route `/app/chat?tool=<id>` uses the same composer; the hero becomes a header block.
- Header block: icon + name, promise, 「你将得到」 (report, evidence matrix, a verified/needs-check mark per claim), 「通常用时」 (measured), 「最好提供」.
- Three starters prefill editable slots rather than send.
- A chip `[icon 名称 ×]` sits in the composer and the placeholder is rewritten. × or Backspace-on-empty removes it and restores the home hero.
- `@` switches tool mid-thread; the chip repeats in the thread header.
- No drawer, no second input.
- Kernel seats exist for this: `conversation.hero.workspace` for the header, and `conversation.input.left` / `input.dock` for the chip. Locale keys register once, so per-tool text must come from the occupant.

**(c) Right panel.**
- Closed on home, landing and plain Q&A.
- It opens itself on two events only:
  - The first plan item opens 「进度」.
  - The first deliverable puts a dot on 「报告」, and the panel switches there at completion if untouched.
- Three tabs (`sidebar.right.pane.tab`):
  - 进度: checklist, elapsed time, sub-agents as nested rows, one Stop.
  - 报告: TOC, per-claim marks with a quote-in-context popover, export, fullscreen.
  - 来源.
- No plan-approval gate: the plan is visible and steered by talking.
- The thread shows one collapsed line per phase and file cards, never tool logs.
- Closing is remembered per run; a 「进度 3/7」 pill above the composer reopens it. Notify on completion.

**(d) Navigation.**
- Five items: 新建 · 历史 · 知识库 · 工具 · 设置.
- 历史 merges conversations and runs, filtered by 进行中/已完成/需处理.
- 记忆胶囊, 主动科研 schedules, connectors and usage move into 设置.
- Autopilot is also a tool card; the inbox becomes a header bell.

**(e) Design language.** Colour already crosses the frame through tokens, so the seam the owner sees is type and geometry. The shell has serif titles, 16 px body, 36 px/8 px controls and a 232 px sidebar. The kernel hard-codes a sans ladder, capsules and a 280/56 px sidebar. The shell should conform to the kernel.
- **Type:**
  - One sans stack (Inter, system-ui, PingFang SC, HarmonyOS Sans SC, MiSans, Microsoft YaHei, Noto Sans CJK SC); no serif in chrome.
  - Sizes 12/13/14/16/20/24 only: 14 for UI and chat, 16 for the report reader, 20 for page titles, 24 for the hero.
  - Weights 400/500/600.
  - Line-height 22 px UI, 1.75 prose, 1.3 headings; tracking 0.
- **Space:** base 4; scale 8/12/16/24/32/48; card padding 16, grid gap 12, gutter 24; column 748, wide 1000; sidebar 280/56.
- **Radii:** 8 for controls and rows, 12 for cards and popovers, 16 for panels and dialogs, 24 for the composer, 999 for chips.
- **Heights:** 32 controls, 28 in-composer chips, 40 for form CTAs only, 36 list rows, 44 nav and tabs, composer 56→200; icons 16/20.
- **Colour roles:** bg, surface-1, surface-2, border-hairline, border-control (≥3:1), text/-2/-3, accent/-soft/-pressed.
  - One accent. Keep 循证青 #00756b, which is already in the frame: white on it is 5.59:1, against 4.23:1 on the kernel's blue.
  - The alternative is to delete the accent rows and take the kernel's blue.
  - One generated table should feed both `index.css` and `runtimeUiTheme.mjs`.
  - Status colours are used only as status, always with shape and word.
- **Flat surfaces:** hairlines; shadow only on menus and dialogs; no gradients, tinted cards or coloured icon tiles.
- **States:** hover surface-2; selected accent-soft; focus 2 px accent ring; disabled 40 %; loading skeleton; running = pulsing dot.

Repo files read:
- `/home/coder/workspace/EviMedScience/OpenScience/DESIGN.md`
- `/home/coder/workspace/EviMedScience/OpenScience/packages/harness-port/src/runtimeUiTheme.mjs`
- `/home/coder/workspace/EviMedScience/OpenScience/apps/web/src/components/sidebar/Sidebar.tsx`

## Sources
[1] https://aiuxplayground.com/teardowns/manus/composer/
[2] https://aiuxplayground.com/teardowns/kimi/composer/
[3] https://aiuxplayground.com/teardowns/chatgpt/composer
[4] https://zapier.com/blog/custom-chatgpt/
[5] https://www.makeuseof.com/how-to-use-gpt-mentions-in-chatgpt-conversation/
[6] https://support.claude.com/en/articles/12512180-use-skills-in-claude
[7] https://aiuxplayground.com/teardowns/claude/composer/
[8] https://support.claude.com/en/articles/11088861-use-research-on-claude
[9] https://www.mydown.com/soft/425/119425.shtml
[10] https://www.cnblogs.com/WindrunnerMax/p/19104743
[11] https://www.readaitime.com/yuanbao
[12] https://blog.csdn.net/moxunjinmu/article/details/147465610
[13] https://www.genspark.ai/helpcenter/ai-slides
[14] https://prompt-architects.com/blog/346-perplexity-focus-modes-which-to-use-when
[15] https://prompt-architects.com/blog/467-perplexity-spaces-for-recurring-research
[16] https://support.elicit.com/en/articles/1418881
[17] https://www.openevidence.com/user-guide
[18] https://www.nbcnews.com/tech/tech-news/openevidence-ai-doctor-medical-physician-login-app-what-npi-uptodate-rcna341064
[19] https://consensus.app/home/blog/consensus-product-feature-updates/
[20] https://spectrumailab.com/blog/how-to-use-manus-ai-beginners-guide-2026
[21] https://docs.devin.ai/work-with-devin/devin-session-tools
[22] https://techcrunch.com/2025/06/30/cursor-launches-a-web-app-to-manage-ai-coding-agents/
[23] https://www.datacamp.com/blog/deep-research-openai
[24] https://www.macrumors.com/2026/02/11/chatgpt-deep-research-mode-document-viewer/
[25] https://support.google.com/gemini/answer/15719111
[26] https://blog.google/products-and-platforms/products/gemini/tips-how-to-use-deep-research/
[27] https://www.kimi.com/zh-cn/help/deep-research/deep-research-overview
[28] https://www.aihub.cn/news/doubao-deepresearch/
[29] https://aiuxplayground.com/teardowns/compare/output-artifacts-refinement
[30] https://aiuxplayground.com/teardowns/perplexity/output/
[31] https://elicit.com/blog/living-documents-ai-ux
[32] https://github.com/Lichtspur/deepseek-style-theme
[33] https://dev.to/victor_desg/agent-ux-is-not-chatbot-ux-and-most-teams-in-2026-ship-them-as-if-they-were-23bi
[34] https://aiuxplayground.com/teardowns/deepseek/composer/
[35] https://github.com/Meliwat/awesome-ios-design-md/blob/main/design-md/misc/deepseek/DESIGN.md
[36] https://github.com/RealHacker/dsh-theme-colorizer
[37] https://github.com/citisen/dsh-font
[38] https://github.com/Physicolor/dsh-ui-harmonizer
[39] https://claude.com/docs/connectors/building/mcp-apps/design-guidelines
[40] https://ant.design/docs/spec/font/
[41] https://w3c.github.io/clreq/zh/
[42] https://www.eleken.co/blog-posts/user-interface-design-for-healthcare-applications
[43] https://www.popularai.org/p/chatgpt-sidebar-pinned-chats-gpts-projects-missing
[44] https://www.ai-toolbox.co/chatgpt-management-and-productivity/how-to-manage-chatgpt-memory-2026
[45] https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
[46] https://manus.im/docs/features/scheduled-tasks
[47] https://www.guideflow.com/tutorial/how-to-show-finance-in-the-sidebar-in-perplexity
