# D — How AI products present long-term memory (web research, 2026-09-20)

Produced by a read-only sub-investigation for `../2026-09-20-产品现状根因分析与一次性整改方案.md`. File and line references are as of commit 70683e97a.

# How AI products present long-term memory, and a one-page recommendation (2026-09-20)

The OpenAI, Perplexity, ACM and Zhihu pages returned 403. Claims marked (s) rest on search snippets or secondary coverage. That includes ChatGPT's June 2026 rebuild, which I could only read through XDA and findskill.

## 1. ChatGPT
- **Two mechanisms:** saved memories and reference chat history each have a toggle under Settings › Personalization › Memory. Deleting a chat does not delete its memory (s). https://help.openai.com/en/articles/8590148-memory-faq
- **Main touchpoint:** the in-chat "Memory updated" chip. Hover shows what was saved; click opens Manage memories (2024-02, s). https://openai.com/index/memory-and-new-controls-for-chatgpt/
- **2025-10-16:** memory is managed automatically, "memory full" is gone, and the list gained search and sort by recency. https://alternativeto.net/news/2025/10/chatgpt-enhances-memory-management-for-plus-and-pro-users
- **2025-05-04:** the chat-history profile carried internal confidence tags and users could not inspect it. https://embracethered.com/blog/posts/2025/chatgpt-how-does-chat-history-memory-preferences-work/
- **2026-06-04 rebuild:**
  - A generated memory summary with timestamps.
  - Edit by typing into a box beneath it, by highlighting a line, or with "Don't mention this again", which suppresses and does not delete.
  - Each reply shows which past chats, memories, instructions or files personalized it.
  - The old list is still reachable.
  - Criticism: the summary "won't include everything".
  - https://www.xda-developers.com/chatgpt-quietly-rewrites-its-memories-of-you-not-sure-i-like-it/ (2026-06-22) and https://findskill.ai/blog/chatgpt-dreaming-memory-explained/
- **Temporary chat** neither reads nor writes memory (s). https://help.openai.com/en/articles/8914046-temporary-chat-faq/
- **Project-only memory** is chosen at project creation and isolated both ways. https://www.techradar.com/ai-platforms-assistants/chatgpt/chatgpt-project-only-memory-is-live-and-it-might-change-how-you-work-with-ai

## 2. Claude
- **Memory summary:** synthesized and refreshed every 24 h. In Settings › Memory › "Topics" you read it, use the edit icon, or Delete; you can also just tell Claude in chat. The page says "updated this week".
- **Same page:** per-project memory and summary, pause vs reset, past-chat search that cites the original chats, and import/export. https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context
- **Rollout:** 2025-09-11 Team/Enterprise, 2025-10-23 Pro/Max (https://claude.com/blog/memory); 2026-03-02 free plan plus copy-paste import (https://www.macrumors.com/2026/03/02/anthropic-memory-import-tool/).
- **Incognito chats:** https://support.claude.com/en/articles/12260368-use-incognito-chats
- **Projects split by author:** instructions (you write), project knowledge (files you upload), memory (Claude writes). https://support.claude.com/en/articles/9517075-what-are-projects

## 3. Gemini
- **2025-08-13:** past-chat personalization on by default, plus Temporary Chat. https://blog.google/products-and-platforms/products/gemini/temporary-chats-privacy-controls/
- **Today:** Settings › Personal Intelligence › Memory. There is no list of what it learned. You ask "Did you use any info from past chats?", correct it in chat, or delete the chats. User-typed instructions ("Saved info") are a separate list. https://support.google.com/gemini/answer/16598469

## 4. Others
- **Microsoft 365 Copilot:**
  - A "Memory updated" notice, a list with Delete / Delete all, no search and no source. https://support.microsoft.com/en-us/microsoft-365-copilot/manage-copilot-memory-in-microsoft-365-copilot
  - Three controls: custom instructions, saved memories, chat history (2026-09-02). https://learn.microsoft.com/en-us/microsoft-365/copilot/copilot-personalization-memory
- **Perplexity:**
  - A list under Settings › Memory and a separate past-searches toggle (2026-04-30, secondary).
  - Used memories appear among an answer's sources. Incognito excludes both. https://supermemory.ai/blog/how-perplexity-memory-works/
  - Spaces hold files plus instructions. https://alternativeto.net/news/2024/10/perplexity-introduces-internal-knowledge-search-and-spaces-feature
- **Manus:**
  - "Knowledge" is a user-filled form (Name / When to use / Content / Status), capped at 50 entries free and 100 Pro (2025-12-09). https://help.manus.im/en/articles/11813718-what-can-i-do-when-i-reach-the-knowledge-base-limit and https://kpcquzyw.manus.space/knowledge-feature (unofficial guide)
  - 2026-05-06: Projects propose instruction, file and skill updates, applied only after approval. https://manus.im/blog/manus-projects-self-updating
- **Notion:** no list. Memory is an editable page the agent can be told to update. https://www.notion.com/help/notion-agent
- **Genspark:** "Auto Research Me" builds the profile from a LinkedIn URL. https://www.genspark.ai/blog/genspark-super-agent-personalized
- **Kimi 记忆空间:** 设置›个性化, a flat list with per-item delete, saved automatically or via "记住…", 50 × 500 chars (s). https://www.kimi.com/zh-cn/help/new-user-guide/memory-space and https://www.kimi.ai/zh-hans/help/features/memory-tips
- **豆包:** 设置›记忆. One switch, memory summaries, delete one or clear all, or say "忘记" in chat (s). https://zhuanlan.zhihu.com/p/2004227382152798788
- **元宝:** no documented long-term-memory surface found.

## 5. Developer dashboards
- **mem0 OpenMemory:** a table (memory · auto-category tags · app · created) with filters, active/paused/archived states and a per-memory access log (2025-05-13). https://dev.to/anmolbaranwal/how-to-make-your-clients-more-context-aware-with-openmemory-mcp-4h71
- **Letta ADE:** labelled editable blocks with character limits, a searchable archival list and a context-window viewer. https://docs.letta.com/agent-development-environment/ade/
- **Zep:** a graph of entities, with facts stored on edges carrying valid/invalid timestamps and episodes as provenance. https://help.getzep.com/graph-overview
- **Cursor** asks approval per background memory (2026-07-05, secondary). https://localskills.sh/blog/cursor-memories-guide
- **Windsurf** saves without approval, per workspace, and its own docs send durable knowledge to Rules. https://docs.devin.ai/desktop/cascade/memories
- **LangMem:** semantic (profile | collection), episodic, and procedural = a rewritten prompt. https://www.langchain.com/blog/langmem-sdk-launch

## 6. Research and guidance
- **HAX guidelines (CHI 2019):** G9 efficient correction, G11 explain why, G13 learn from behaviour, G14 update cautiously, G17 global controls, G18 notify about changes. https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/
- **Shape of AI:** "Memory should never be a black box"; show a chip on every save. https://www.shapeof.ai/patterns/memory
- **2,050 real ChatGPT memories (2026-02):** 96% were written without a request, 52% are psychological inference, 84% are grounded. https://arxiv.org/abs/2602.01450
- **Inference (2026-05):** discomfort arises "mainly when inferences felt misrepresentative". https://arxiv.org/abs/2605.10013
- **Interviews (2025-08):** users want review, edit and delete plus visibility into use. https://arxiv.org/abs/2508.07664
- **CHI 2026:** mental models shift once people see what is stored (s). https://dl.acm.org/doi/10.1145/3772318.3791635
- **Smashing Magazine (2026-05-13):** the audit trail as "the receipt of my work". https://www.smashingmagazine.com/2026/05/practical-interface-patterns-ai-transparency/
- **NN/g:** nothing memory-specific found.

## (a) Patterns that recur
1. There is one surface: a generated summary on top and one flat list beneath (ChatGPT 2026, Claude, 豆包). No consumer product reviewed has a second memory page.
2. The chat is the touchpoint, through a "memory updated" chip. The page is where people go to audit.
3. Provenance runs both ways: where a memory came from, and which memories shaped this answer.
4. The AI writes without approval. Control is one switch, per-item delete and temporary chat. Cursor's and Manus's approvals are outliers.
5. Users correct memory by talking, not by filling forms.
6. Scope is by project, never by data type.
7. Separation is by author: what you put in is Knowledge/Files, what the AI wrote is Memory.

## (b) Anti-patterns matching the complaint
- **Tabs named after internal stores.** Categories, states, graphs and access logs exist only in developer dashboards.
- **Authoring forms** (Manus Knowledge, Gemini instructions). That is custom instructions, a different feature.
- **Confidence percentages.** The one documented confidence tag (ChatGPT's) stayed internal; none of the consumer memory pages reviewed shows one.
- **A timeline tab.** None of the products reviewed ships one. Time appears as a timestamp, a recency sort and version history.
- **Memory that acts but is not listed.** This is fatal with clinicians. Counting rows you never show is the same defect.
- **Suppress-vs-delete ambiguity, and approval queues.**

## (c) Recommendation: one page, 「记忆」
Print one rule under both page titles: 知识库 = 你放进来的资料; 记忆 = AI 记下的关于你和项目的事.

Move 资料库 into 知识库. Delete 概览 and 时间线. 项目档案 and 方法 become filters. The project page shows the same rows filtered, so there is one store with two entry points.

Page order:
1. **Header:** one on/off switch, a pointer to 无痕对话, and a scope filter 全部 / 关于我 / 当前项目.
2. **「我对你的了解」:**
   - Four to six generated sentences under 你和你的研究方向 · 你的工作方式 · 本项目.
   - Every sentence links to its rows, and nothing appears without a row. This avoids ChatGPT's "won't include everything" failure.
   - One box beneath: 「哪里不对?直接告诉我」.
3. **最近变化:** the last five adds, updates and undos, each with 撤销. This replaces the timeline tab, and keeps the owner's earlier wish for a view of change over time.
4. **The list:** chips 全部 · 关于我 · 工作方式 · 项目 · 已忘记(30 天可恢复); sort by 最近使用 or 最近更新.

**Each row** shows:
- one Chinese sentence and a scope chip;
- an origin label: 你说的 / AI 推断 / 运行结果;
- 「来自 9月12日《…》对话」, deep-linked to the message;
- 「用过 7 次,上次 9月18日」;
- 改 (inline) and 忘记;
- on 推断 rows, a one-click 「不对」.

Strength is shown as a count ("3 次对话"), never a percentage. Expanding a row shows its versions and the runs that used it.

**Search:** one box, keyword plus semantic, over the sentence, the source-conversation title and the project. Each hit shows the runs it influenced, so search also answers "why did it say that".

**Working style** is never authored by the user:
- Learn it from adopted deliverables and the user's own edits.
- Show it as ordinary rows under 工作方式, written as observed behaviour and linked to those edits, e.g. 「Meta 分析先报 GRADE 再报效应量(从你改过的 3 份报告学到)」.
- It takes effect immediately, and the next run shows 「已按你的习惯:…」 with 撤销.
- One collapsed free-text box, 固定要求, is the only thing a user ever types.
- Sharing, from the owner's capsule vision (one user switches to another's capsule and that user's methods take effect), is a single 「分享我的工作方式」 action on that filter.

**In chat:**
- A 「已记住:…」 chip with 撤销.
- A 「本次用到的背景」 expander per answer, with 「别再用这条」 per item. The run ledger already holds this data as `recalledMemories` and `methodsLoaded`.
- 无痕对话 at the composer.

Local context used: /home/coder/.claude/projects/-home-coder-workspace-EviMedScience/memory/memory-capsule-vision-and-gap-2026-09-19.md. The proposal that note points to specified a six-section capsule page, which shipped as the six tabs the owner now rejects.
