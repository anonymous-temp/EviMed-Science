# Module renames of 2026-10-07 — the string list for the EviMed main site

The EviMed main site (the Vue shell) is another repository. This is what the Science side changed on
2026-10-07 and where its pages show the two names, so the shell can say the same words in its own sidebar,
bell, landing page and e-mails.

## The two names

| Retired name | Name now | Code identifier (unchanged) | Since |
|---|---|---|---|
| 循证传播 | **循证 GEO** | `geo` | 循证传播 was used only from 2026-10-06; the module was 「循证 GEO」 before that and is again |
| 虚拟临研 | **虚拟临床研究** | `vcr` | 虚拟临研 was the name from 2026-09-28 |

Write 「循证 GEO」 with a half-width space between 循证 and GEO (and after GEO when Chinese follows:
「循证 GEO 项目」). Write 「虚拟临床研究」 as one word, six characters.

Related words that stay: 「AI 回答监测」 names the measurement screens inside 循证 GEO (visibility, accuracy,
questions and one answer's page); it never named the module and does not change. 「循证 GEO」 is not the
public NCBI Gene Expression Omnibus workflow, which is 「基因表达差异分析」 and keeps `gene-expression`.

## What did not change

- URLs: `/app/geo`, `/app/geo/<id>[/<tab>]`, `/app/virtual-research`, `/app/virtual-research/<id>[/<tab>]`;
  APIs `/api/geo/*` and `/api/vcr/*`; notification links; bookmarks. No redirect is needed.
- Identifiers: schemas `evimed_geo` and `evimed_vcr`, capability ids `geo-*` and `vcr-*`, tool names,
  `OPEN_SCIENCE_GEO_*` and `OPEN_SCIENCE_VCR_*` keys, `/api/me` feature flags `features.geo` and `features.vcr`.
- Stored data: conversations, memories and notices written before the rename keep the words they were written
  with. Only what the product writes from now on, and every label it draws, uses the new names.

## Where the Science pages show the names

Replace the old string with the new one in every row. A sidebar or heading that carries the name alone is
the one to match first.

### Navigation and page titles

| Where | Old | New |
|---|---|---|
| Sidebar row below 科研工具 (`/app/geo`) | 循证传播 | 循证 GEO |
| Sidebar row below 科研工具 (`/app/virtual-research`) | 虚拟临研 | 虚拟临床研究 |
| Sidebar project list: the two module groups at the end | 循证传播 · 虚拟临研 | 循证 GEO · 虚拟临床研究 |
| 知识库 scope menu: the two module groups | 循证传播 · 虚拟临研 | 循证 GEO · 虚拟临床研究 |
| 记忆胶囊 project selector: the two module groups | 循证传播 · 虚拟临研 | 循证 GEO · 虚拟临床研究 |
| Page title, home of each module, and the study page's back link (「‹ 虚拟临研」) | 循证传播 · 虚拟临研 | 循证 GEO · 虚拟临床研究 |
| The home list of 循证 GEO: its accessible label and empty state | 循证传播项目 · 还没有循证传播项目 | 循证 GEO 项目 · 还没有循证 GEO 项目 |
| Module not open for the account | 循证传播还没有在这个工作空间开放。 / 虚拟临研还没有在这个工作空间开放。 | 循证 GEO 还没有在这个工作空间开放。 / 虚拟临床研究还没有在这个工作空间开放。 |
| Study removal toast and confirmation | 研究已从虚拟临研移除。 / 研究会从虚拟临研移除；项目里的对话和文件仍在。 | 研究已从虚拟临床研究移除。 / 研究会从虚拟临床研究移除；项目里的对话和文件仍在。 |
| Browser tab names | the same words | the same replacements |
| Default name of a project made before its brand is known | 新循证传播项目 (and 新 GEO 项目 before 2026-10-06) | 新循证 GEO 项目 — a project still holding either earlier name is renamed by the brand as before |

### The conversation

| Where | Old | New |
|---|---|---|
| Chip on the composer of a module conversation, and its 「移除」 label | 循证传播 · 虚拟临研 | 循证 GEO · 虚拟临床研究 |
| Starter sentence for a full programme | 做一套完整的循证传播方案，从证据、问题、诊断到内容、投放和监测 | 做一套完整的循证 GEO 方案，从证据、问题、诊断到内容、投放和监测 |
| Tool narration | 读取循证传播项目：… / 写入循证传播项目：… / 读取循证传播数据 / 写入循证传播数据 | 读取循证 GEO 项目：… / 写入循证 GEO 项目：… / 读取循证 GEO 数据 / 写入循证 GEO 数据 |
| Run brief the platform writes into a module conversation | 「循证传播」自动运行 · 第 N 步… | 「循证 GEO」自动运行 · 第 N 步… |
| Capability display names (kept out of 科研工具, shown on the chip and in the run list) | 循证传播 · 分层稿件 / 循证传播 · 提案资料包 / 循证传播 · 信源与目标 / 循证传播 | 循证 GEO · 分层稿件 / 循证 GEO · 提案资料包 / 循证 GEO · 信源与目标 / 循证 GEO |
| Capability category of 研究定义与入排结构化, 人群、对照与试验仿真 and 研究包与沟通资料 | 虚拟临研 | 虚拟临床研究 |

### Notices, alerts, billing, errors

| Where | Old | New |
|---|---|---|
| Inbox notices of each module (titles and bodies that name the module or say 「在“循证传播”的投放账户里处理」) | 循证传播 · 虚拟临研 | 循证 GEO · 虚拟临床研究 |
| Fallback names in a notice | 循证传播项目 · 虚拟临研研究 | 循证 GEO 项目 · 虚拟临床研究 |
| Operator alerts (Prometheus rule summaries and the notice titles built from them) | 循证传播有严重的回答偏差未处理 · 循证传播的探测停了 · 循证传播探测主机上有… | 循证 GEO 有严重的回答偏差未处理 · 循证 GEO 的探测停了 · 循证 GEO 探测主机上有… |
| 用量 page, purpose column | 循证传播 · 虚拟临研 | 循证 GEO · 虚拟临床研究 |
| Error sentences of every `geo_*` and `vcr_*` code (for example 「循证传播这次没能完成这个操作，稍后再试。」) | 循证传播… · 虚拟临研… | 循证 GEO… · 虚拟临床研究… |
| E-mail and Feishu cards that quote a notice | as the notice | as the notice |

### Search

The Science search boxes over tools, skills and plugins read the old names as the new ones until
**2027-01-07**; the old name is never printed back. A shell search that should keep finding the modules
by their old names for the same three months can map them the same way: 循证传播 → 循证 GEO,
虚拟临研 → 虚拟临床研究.

## For the main site's own copy

- If the shell's sidebar, landing page or e-mails still say 「循证 GEO」 from before 2026-10-06, nothing
  changes for that name. If they were moved to 「循证传播」 on or after that date, move them back.
- Anything that says 「虚拟临研」 becomes 「虚拟临床研究」. The sidebar has room for the six characters.
- Links into Science keep working as they are.
- After the change, search the shell's pages for both retired words; Science's own walk fails a page that
  still shows either of them.
