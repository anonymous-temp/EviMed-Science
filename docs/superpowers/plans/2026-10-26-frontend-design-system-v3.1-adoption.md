# Frontend Design System v3.1 Adoption

2026-10-26. Owner review disposition and implementation contract. The owner authorized adopting the recommended decisions while revising the specification. This file records those decisions and the future implementation sequence; it is not an assertion that component APIs, the token major release, a merge or deployment are complete.

## Source and status

- Canonical specification: [Frontend Design System v3.1](../../../OpenScience/docs/FRONTEND_DESIGN_SYSTEM.md).
- Engineering/component contract adoption: [DESIGN.md](../../../OpenScience/DESIGN.md).
- The October 26 remote read of `main` returned token 2.2.0 and 404 for the full specification path. The local branch is `codex/scheduled-tasks-correction-20261025`, based on `23c84044a934ec73d8482045ddfecd1159e18c2f`, with the earlier warm-brand 2.3.0 candidate and unrelated changes preserved.
- Adopted release target: token 3.0.0. The 2.3.0 candidate is not the shipping version for the reviewed semantic migration. Current source values and adopted target values are deliberately distinct in the specification.
- This revision edits documentation only. Runtime behavior, component implementations, generated assets and their recorded prior test outcomes are not relabeled as newly fixed or newly passed.

## Review disposition

All recommended decisions are resolved. A clarification below preserves the intended outcome while correcting a source assumption or an unsafe implementation shortcut.

| ID | Review item | Adopted resolution | Authority / proof |
|---|---|---|---|
| R01 | Main does not contain the delivery | Confirmed by remote read; show local/main/release states and require coordinated adoption | Spec 1.1, DS20; AT50 |
| R02 | Major version | Adopt 3.0.0 for coordinated brand/status reinterpretation; not a universal rule that every color tuning is major | DS03; version/digest/consumer tests |
| R03 | Verification color | `verify-ok` uses `ok` green; scope of verification remains explicit | DS02.a; AT31 |
| R04 | Title ink | Exact `text` role in both themes; local light title is already neutral, so avoid claiming all titles remain blue | DS02.b; role equality |
| R05 | Running color | Information role, plus shape/word, including independently styled step/tab call sites | DS02.d; state gallery |
| R06 | Information navy | Adopt #18324d family with measured dark/soft counterparts; not a second action accent | DS02.c; contrast/gallery |
| R07 | Field focus | Add focus-input from brand ink; keep button/link focus accent; preserve simultaneous error and focus | DS02.e; forced-color/field fixture |
| R08 | Chart separation | Preserve categorical scientific colors; own/rival comparison uses CHART_OWN/CHART_COLORS, not CHART_SERIES. Add real CIE76 assertions >=15; existing chartPalette comments do not measure it | DS02.f; AT32 |
| R09 | Study-type colors | Retain the closed categorical set as an explicit study-data exception, with text labels and contrast | DS02.g; AT31 |
| R10 | Popularity versus safety tags | New/rising become neutral with words/supporting glyphs | DS02.h; caller/gallery checks |
| R11 | Host/kernel responsibility | H/K/B on rules and acceptance; native composer/streaming remain upstream-owned | Spec 1.2, Appendix A; AT47 |
| R12 | Component JSDoc | Adopt nine ordered fields with real tests/gallery/composition references; no separate component handbook | DESIGN template; AT50 |
| R13 | Busy Button | Focus/name/width stability plus a real click/key/form guard; native disabled retained for unavailable prerequisites. Browser focus loss is verified in rendering, not assumed universal | DESIGN adoption; AT35 |
| R14 | Switch pending | Immediate reversible preference: one optimistic move, pending lock, confirmed-failure rollback; unknown outcomes reconcile. Delayed activation uses an apply action/status | DS21.2; AT36 |
| R15 | Hints and scientific numeric input | Unify hints/slots; NumberField explicit unit/scale/bounds/example, raw versus parsed value, shared formatting on blur and submit | DESIGN quantity contract; AT37 |
| R16 | FormDialog and Drawer | Shared useUnsavedGuard, footer and persistent error summary; no duplicated guard state; retain focusable help during pending work | DS21.3; AT38 |
| R17 | ConfirmDialog | Structured object/count/consequence/recovery; real undo/history for recoverable operations | DS21.3; AT39 |
| R18 | Focus helper | Use proven tabbability or complete equivalent tests; tabIndex plus ancestor filtering alone misses first-legend/radio/visibility semantics | DS08; AT13 |
| R19 | Toaster and shared announcements | Pre-mounted host regions, event/entity-scoped dedup, real AT acceptance; inline persistence stays primary. No claim that all current AT fails without a run | DS21.4; AT41 |
| R20 | Tabs | Manual activation for expensive/asynchronous panels; auto allowed for promptly available panels | DS21.5; AT42 |
| R21 | Typed StatTile | Measured/Unmeasured/Failed boundary plus read lifecycle and adapter tests. Typing cannot prove a caller did not incorrectly create Measured(0) | DESIGN reading contract; AT37 |
| R22 | InlineAlert and ghost alias | Shared persistent feedback for LoadError/DataTable; migrate touched ghost call sites to secondary without changing unrelated APIs | DESIGN adoption; AT40 |
| R23 | ListRow copy | Preserve semantic row target, make meta/identifier copy possible without navigation, document title hit-area tradeoff and full-detail copy | DESIGN adoption; AT44 |
| R24 | Async Combobox | First larger missing input primitive, introduced with a real caller; query/selected identity, stale responses, IME and keyboard are explicit | DESIGN missing primitives; AT49 |
| R25 | Checkbox and Radio | Native labeled form semantics, mixed selection and group keyboard; chips do not replace consent/form controls | DESIGN missing primitives; AT48/49 |
| R26 | DateField and DateRange | Native-first; date-only versus zoned instant, endpoint inclusivity and validation explicit | DS21.8; AT45/49 |
| R27 | FileDrop | File picker and drag equivalent, per-item transfer/parse/readiness, actual progress denominator; uploads are not the only legitimate measured progress | DS13/21.1; AT23/49 |
| R28 | Freshness | Last successful time and failed-refresh retry beside useful retained data | DS21.4; AT40 |
| R29 | Batch selection | Support opt-in where backend permits; explicit page/all-query scope, stable IDs, partial failure and safe retry | DS21.10; AT48 |
| R30 | Latency budgets | Immediate control feedback; avoid fast-read flash; 300ms meaningful pending, 10s truthful duration/cancel, 60s durable continuation only when supported | DS21.1; AT33/34 |
| R31 | Mutation vocabulary | idle/pending/settled/failed-reverted/failed-kept; unknown server outcome retains intent and reconciles | DS21.2; AT35-37 |
| R32 | Undo first | Real reversible path before confirmation; no fictional recycle bin or cancellation guarantee | DS21.3; AT39 |
| R33 | Feedback placement | Field/summary, InlineAlert, Freshness, toast, inbox and badge have distinct purposes | DS21.4; AT40/41 |
| R34 | Keyboard map | Context-limited viewer map and native editor ownership. Existing ? and Cmd/Ctrl+B retained; / is native slash input, not a proved host-global binding | DS21.5; AT42/47 |
| R35 | Navigation closing | Shared router/layout handling after accepted destination; respect blocked navigation and focus ordering | DS21.6; AT43 |
| R36 | Long/duplicate names | Middle truncation where compact; stable display-only suffix, no persisted renaming, full accessible/touch identity | DS21.7; AT44 |
| R37 | Copy/numbers/dates | Action-oriented copy, three-part error meaning, tabular/grouped values and unit spacing; lib/format authority, 24h policy, explicit Asia/Shanghai and date-only exceptions | DS21.8; AT45 |
| R38 | IME consolidation | Shared host field/submit guard and scoped lint; kernel tested separately; no blanket ban on accessible Enter handlers | DS21.9; AT46/47 |
| R39 | Every rule has proof | Owner/proof row for every DS group, specific DS02/DS21 rows and component migration proof; missing tests remain open | Appendix A; AT50 |
| R40 | Product versus design layering | DS15-17 point to module authorities; UI invariants retained through dated handoffs in module plans | Module register below |
| R41 | Chinese divergence | Keep v3.0 Chinese body frozen; publish a dated link/change index, not another full normative body | DS20; source/date/hash in revision receipt |
| R42 | Sequencing | Coordinated authority/roles, typed P1 boundaries, core interaction repairs, real-use primitives/mobile, product migration, then complete release acceptance | Work packages below |

## Work packages and closure

Statuses: **specified** means the decision/contract exists; **implemented** needs code plus tests; **accepted** needs the required rendered/user proof; **released** needs consumer/serving identity. The rows below are specified only in this revision. Assign implementation owners by responsibility, without inventing a named person's commitment.

| Package | Responsibility and scope | Dependencies / exit |
|---|---|---|
| W1 coordinated brand release | Token/host/native integration owners: adopt 3.0.0, DS02 role table, generated artifacts, state-dot callers, field focus and neutral tags; align docs/AGENTS and consumer pins | All relevant contrast/role/distance tests, theme fixtures, supported native mapping, exact external consumer adoption plan. Integrate as a focused reviewed change without sweeping in unrelated dirty work |
| W2 typed metric and quantity boundaries | Domain/view-model and UI owners: StatTile reading union, backend missingness adapters, NumberField/shared formatter and real metric/form callers; minimal InlineAlert/Freshness where required | Unknown/zero/failure/stale counterexamples, unit round trips, serving/source reconciliation. These P1s close only after the actual affected pages pass |
| W3 shared interaction repairs | UI foundation owner: focusTrap, announcer/Toaster, Button, Switch, dialog/footer/dirty guard, manual Tabs; caller migration and contract headers | AT13/35/36/38-42. Do not call these small props-only edits: async races, browser focus and AT need explicit proof |
| W4 missing primitives and navigation | UI/module owners: Combobox first larger input, native Checkbox/Radio, then DateField/DateRange and FileDrop with real consumers; shared mobile closure, identity, IME and format consolidation | AT43-49; InlineAlert/announce precede consumers that need them. No unused library component added merely to complete a list |
| W5 module migrations and content | Module owners follow their plans: AI-native VCR, GEO task/result/attention semantics, reader hierarchy, sparse map legibility, localized extensions and incident grouping | Existing product/scientific contracts, data/history/permission preservation and task-specific rendered journeys |
| W6 integration and release | Coordinator verifies actual build/source/consumer identities, all new AT scenarios and explicit residuals; token/UI and runtime images where relevant | Host/native light/dark/forced-color, actual files, keyboard/touch/AT, selected durable tasks, installed cache and external Vue readback. No deployment inferred from local checks |

Do not merge only prose that tells consumers they already run 3.0.0. The coordinated W1 change must contain the actual versioned bytes and consumer evidence, or explicitly remain an unreleased specification. The source branch currently contains other work, so a release/change set must be scoped and reviewed before integration. This revision does not create, merge or deploy a PR.

## Module-policy register

| Module | Maintained authority | Design-system boundary |
|---|---|---|
| GEO | [GEO iteration plan](2026-10-23-geo-profound-pureblue-todo.md), including the October 26 UI handoff | DS09/15/21 define truthful metrics, components and navigation mechanics; the plan owns sequence and business objects |
| VCR | [AI-native reset](../specs/2026-10-25-vcr-ai-native-product-reset.md), including its UI handoff | DS07/13/16 govern reusable input/viewer rules; the reset owns scope and task entry |
| Scheduled tasks | [Correction plan](2026-10-25-scheduled-tasks-correction.md), with the UI handoff | Scope/timezone/recurrence, enabled versus execution, result conversation, real timed execution and human continuation remain product acceptance |
| Extensions | [Extension-center design](../specs/2026-10-01-dsh-ecosystem-and-extension-center-design.md) and the UI handoff | Discovery/install/configured/active, real project/source/version/effective-time are product lifecycle, not an appearance toggle |
| Account and usage | This register's paragraph below and current backend contracts | DS09/21 own shared error/freshness/formatting; pricing, quota and access are not redefined by a design change |
| Inbox and operator updates | This register's paragraph below and current notification contracts | DS21.4 owns channel choice and announcement; the module owns role visibility and durable delivery |

Account settings group identity, appearance, notifications, quota, connectors and projects. Unknown usage/cost is not zero; show period, unit, expiry and estimates, with simulated balances visibly identified. Proper connector names remain valid. No new billing/security effect follows from a UI review.

The inbox distinguishes user decisions, completion, safety and information. Group repeated updates by incident/current state, preserving count/history and safety urgency. The audited account had operator access; do not infer ordinary-user exposure. Actionable notifications land on the precise task/result. Counts of unread items are not themselves priority grades, and automatic service recovery is not an unanswerable user to-do.

## Acceptance evidence to attach during implementation

Each work package records rule IDs, source revision, component/caller changes, positive and counterexample tests, gallery/composition case IDs, actual browser/native version and remaining limits. Native iframe checks are separate from a host walk that disables iframe scanning. Type checks and component stories never substitute for the producing API's truth or a real user journey. Previous v3 audit evidence remains historical; do not rewrite its past measurements as results of future fixes.

## Evidence from this specification revision

The existing `chartPalette.test.ts` passed all three identity/order checks unchanged. A separate one-off calculation measured six light/dark own-versus-rival CIE76 pairs (minimum 45.4329) and 32 proposed information/focus/verification role pairs (minimum contrast 4.6029:1). These calculations support the chosen values; they are not permanent migrated token tests, a rendered color-vision assessment or proof that the proposed roles have been implemented. The revision artifact preserves inputs/formula/results.

Document checks cover 21 DS groups, 50 AT cases, 42 review dispositions, all 43 current UI TSX modules in the migration register, local links including file line suffixes, and preservation of prior implementation/generated-artifact bytes. No full platform test run or new browser acceptance was performed for this documentation-only revision.
