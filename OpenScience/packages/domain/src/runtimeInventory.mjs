/**
 * What a runtime session of this image is made of, and the words that show it to a person.
 *
 * Hidden knowledge: 「插件与技能」 listed what somebody had written a row for. LoopX (`长任务`), OpenViking's memory plugin,
 * the kernel's own step list, sub-agents and hand-over, and the 51 skills of the GEO method pack were in every session and
 * on no page, because the page's members were typed by hand and the image's members were built, with nothing between the
 * two that could fail (audit A §1; owner 2026-10-14: 「loopx 这插件……技能与插件那里看不到」). Two files make the link:
 *
 *   runtime-inventory.json     generated (`scripts/build/generate-runtime-inventory.mjs`) from the composition snapshot the
 *                              image build diffs against what the kernel really composes, the agent preset, the tool names,
 *                              the skill roots and the LoopX CLI's recorded skills — the image's own list;
 *   runtime-inventory-zh.json  written by hand: the items a person is shown (title, one line, what it does, how it is used,
 *                              icon, control, gate) and, for everything else, the reason there is nothing to show.
 *
 * `unaccountedInventory` is the comparison, and `test/runtimeInventory.test.mjs` is red until it is empty: a bundle, an
 * enabled row, a skill root, a tool set or a LoopX skill that appears with neither an item nor a reason is a decision
 * somebody makes, in a file, and not a thing nobody noticed. Disabled rows are not mounted in a session and need no
 * words; the day one is enabled the baseline changes and the test asks.
 *
 * Pure. `listInventory` is the one place an account's list is decided: the words come from the vocabulary, the facts from
 * the control plane (`inventoryRoutes.mjs`), and nothing a deployment's operator would read ever reaches it.
 *
 * Kept out of the domain's root export, like the package table: the control plane reads it through
 * `@evimed/domain/runtime-inventory`.
 *
 * @module @evimed/domain/src/runtimeInventory
 */

import generated from './runtime-inventory.json' with { type: 'json' }
import vocabulary from './runtime-inventory-zh.json' with { type: 'json' }
import { researchToolGroups } from './researchToolDisplay.mjs'

/**
 * @typedef {'enabled' | 'disabled' | 'conditional'} RowState
 * @typedef {{ id: string, name: string, bundle: string, patchedBy: string[], state: RowState }} HostRow
 * @typedef {{ id: string, name: string, state: RowState }} PresetRow
 * @typedef {{ id: string, mount: string, gate: string | null, kind: string, source: string | null }} SkillRoot
 * @typedef {object} RuntimeInventory
 * @property {{ source: string, sha256: string, bundles: string[], rows: HostRow[] }} composition
 * @property {{ source: string, sha256: string, rows: PresetRow[] }} preset
 * @property {Record<'research' | 'memory' | 'socket' | 'kernel', string[]>} toolSets
 * @property {SkillRoot[]} skillRoots
 * @property {{ source: string, entry: string, kept: string[] }} loopxSkills
 *
 * @typedef {{ kind: 'none' } | { kind: 'switch', setting: string }} ItemControl
 * @typedef {{ kind: 'drawer' } | { kind: 'page', to: string }} ItemOpens
 * @typedef {{ config?: string, tool?: string, project?: string } | null} ItemGate
 * @typedef {object} InventoryWord one thing a person is shown
 * @property {string} group
 * @property {string} title
 * @property {string} icon a name the web maps to its icon set
 * @property {string} use the line a row carries, at most {@link USE_MAX} characters
 * @property {string} does
 * @property {string} how
 * @property {ItemControl} control
 * @property {ItemOpens} opens
 * @property {ItemGate} gate
 * @property {{ title: string, does: string }[]} [parts]
 * @property {Record<string, string>} [toolSentences] what each tool the item's plugin lists does, by the name the plugin reports
 * @property {string[]} bundles
 * @property {string[]} rows
 * @property {string[]} agentRows
 * @property {string[]} skills
 * @property {string[]} toolSets
 */

/** The longest `use` line: a row is one line on a page of the product's width. */
export const USE_MAX = 40

/** The generated inventory. @type {Readonly<RuntimeInventory>} */
export const RUNTIME_INVENTORY = /** @type {any} */ (generated)

/** The hand-written words. */
export const RUNTIME_INVENTORY_WORDS = /** @type {{
 *   groups: { id: string, title: string }[],
 *   items: Record<string, InventoryWord>,
 *   plumbing: {
 *     bundles: Record<string, string>, rows: { reason: string, ids: string[] }[], agentRows: { reason: string, ids: string[] }[],
 *     skills: { reason: string, ids: string[] }, toolSets: Record<string, string>,
 *   },
 *   skillRoots: Record<string, { listed: boolean, how?: string, reason?: string }>,
 * }} */ (/** @type {any} */ (vocabulary))

/**
 * What the generated inventory holds that the words do not account for, and what the words name that the inventory no
 * longer holds. Every list empty is the state the test holds the repository to.
 *
 * @param {RuntimeInventory} [inventory]
 * @param {typeof RUNTIME_INVENTORY_WORDS} [words]
 */
export function unaccountedInventory(inventory = RUNTIME_INVENTORY, words = RUNTIME_INVENTORY_WORDS) {
  const items = Object.values(words.items)
  const plumbing = words.plumbing
  const union = (/** @type {(item: InventoryWord) => string[]} */ pick) => new Set(items.flatMap(pick))
  const itemBundles = union((item) => item.bundles)
  const itemRows = union((item) => item.rows)
  const itemAgentRows = union((item) => item.agentRows)
  const itemSkills = union((item) => item.skills)
  const itemToolSets = union((item) => item.toolSets)
  const plumbedRows = new Set(plumbing.rows.flatMap((group) => group.ids))
  const plumbedAgentRows = new Set(plumbing.agentRows.flatMap((group) => group.ids))
  const plumbedSkills = new Set(plumbing.skills.ids)

  const hostRows = inventory.composition.rows
  const presetRows = inventory.preset.rows
  const allHostIds = new Set(hostRows.map((row) => row.id))
  const allPresetIds = new Set(presetRows.map((row) => row.id))
  const bundles = new Set(inventory.composition.bundles)
  const roots = new Set(inventory.skillRoots.map((root) => root.id))
  const kept = new Set(inventory.loopxSkills.kept)
  const toolSets = new Set(Object.keys(inventory.toolSets))

  /** @type {Record<string, string[]>} */
  const found = {
    bundles: [...bundles].filter((bundle) => !itemBundles.has(bundle) && !Object.hasOwn(plumbing.bundles, bundle)),
    // A mounted row is the words' to account for, one by one, unless its whole bundle is an item (a third-party plugin
    // is the thing it shows, and a row it adds belongs to it).
    rows: hostRows.filter((row) => row.state !== 'disabled' && !itemBundles.has(row.bundle) && !itemRows.has(row.id) && !plumbedRows.has(row.id)).map((row) => row.id),
    agentRows: presetRows.filter((row) => row.state !== 'disabled' && !itemAgentRows.has(row.id) && !plumbedAgentRows.has(row.id)).map((row) => row.id),
    skillRoots: [...roots].filter((root) => !Object.hasOwn(words.skillRoots, root)),
    skills: [...kept].filter((name) => !itemSkills.has(name) && !plumbedSkills.has(name)),
    toolSets: [...toolSets].filter((set) => !itemToolSets.has(set) && !Object.hasOwn(plumbing.toolSets, set)),
    // Words about something the inventory does not hold (renamed upstream, deleted here): a dead entry.
    dead: [
      ...[...itemBundles, ...Object.keys(plumbing.bundles)].filter((name) => !bundles.has(name)).map((name) => `bundle ${name}`),
      ...[...itemRows, ...plumbedRows].filter((id) => !allHostIds.has(id)).map((id) => `row ${id}`),
      ...[...itemAgentRows, ...plumbedAgentRows].filter((id) => !allPresetIds.has(id)).map((id) => `agent row ${id}`),
      ...Object.keys(words.skillRoots).filter((root) => !roots.has(root)).map((root) => `skill root ${root}`),
      ...[...itemSkills, ...plumbedSkills].filter((name) => !kept.has(name)).map((name) => `skill ${name}`),
      ...[...itemToolSets, ...Object.keys(plumbing.toolSets)].filter((set) => !toolSets.has(set)).map((set) => `tool set ${set}`),
    ],
    // Said twice: an item and a reason, or two reasons, for one thing.
    duplicated: [],
  }
  const seen = new Map()
  const once = (/** @type {string} */ kind, /** @type {string} */ id, /** @type {string} */ by) => {
    const key = `${kind} ${id}`
    if (seen.has(key)) found.duplicated.push(`${key} (${seen.get(key)} and ${by})`)
    else seen.set(key, by)
  }
  for (const [name, item] of Object.entries(words.items)) {
    for (const bundle of item.bundles) once('bundle', bundle, `item ${name}`)
    for (const id of item.rows) once('row', id, `item ${name}`)
    for (const id of item.agentRows) once('agent row', id, `item ${name}`)
    for (const skill of item.skills) once('skill', skill, `item ${name}`)
    for (const set of item.toolSets) once('tool set', set, `item ${name}`)
  }
  for (const bundle of Object.keys(plumbing.bundles)) once('bundle', bundle, 'plumbing')
  for (const group of plumbing.rows) for (const id of group.ids) once('row', id, 'plumbing')
  for (const group of plumbing.agentRows) for (const id of group.ids) once('agent row', id, 'plumbing')
  for (const skill of plumbing.skills.ids) once('skill', skill, 'plumbing')
  for (const set of Object.keys(plumbing.toolSets)) once('tool set', set, 'plumbing')
  return found
}

/**
 * @typedef {object} InventoryFacts what the control plane knows about one account's project
 * @property {Record<string, boolean | null | undefined>} [config] the deployment's switches, by the config key an item's gate names
 * @property {Record<string, boolean | null | undefined>} [projectSettings] the project's own switches, by setting id
 * @property {Iterable<string>} [declinedTools] the tools this account's runtime is not given
 */

/**
 * @typedef {object} ListedItem
 * @property {string} id
 * @property {string} title
 * @property {string} use
 * @property {string} icon
 * @property {'on' | 'off'} state `off` only for a thing the person can switch (a project setting), never a state they cannot change
 * @property {ItemControl} control
 * @property {ItemOpens} opens
 * @property {string} does
 * @property {string} how
 * @property {{ title: string, does: string }[]} [parts]
 * @property {Record<string, string>} [toolSentences]
 * @property {true} [showsTools] its drawer lists the account's research tools (`researchTools` of the same answer)
 */

/**
 * The list one account's project is shown: each group's items in the order the words keep them, an item whose deployment
 * switch is off or whose tool this account is not given left out — a thing nobody can use is not a row — and each item's
 * state, which is on unless it is a project setting the person has switched off.
 *
 * @param {InventoryFacts} [facts]
 * @param {typeof RUNTIME_INVENTORY_WORDS} [words]
 * @returns {{ id: string, title: string, items: ListedItem[] }[]}
 */
export function listInventory(facts = {}, words = RUNTIME_INVENTORY_WORDS) {
  const config = facts.config ?? {}
  const settings = facts.projectSettings ?? {}
  const declined = new Set(facts.declinedTools ?? [])
  return words.groups
    .map((group) => ({
      id: group.id,
      title: group.title,
      items: Object.entries(words.items).flatMap(([id, item]) => {
        if (item.group !== group.id) return []
        const gate = item.gate
        if (gate?.config && config[gate.config] === false) return []
        if (gate?.tool && declined.has(gate.tool)) return []
        const state = gate?.project ? (settings[gate.project] === true ? 'on' : 'off') : 'on'
        /** @type {ListedItem} */
        const listed = { id, title: item.title, use: item.use, icon: item.icon, state, control: item.control, opens: item.opens, does: item.does, how: item.how }
        if (item.parts) listed.parts = item.parts.map((part) => ({ ...part }))
        if (item.toolSentences) listed.toolSentences = { ...item.toolSentences }
        if (item.toolSets.includes('research')) listed.showsTools = true
        return [listed]
      }),
    }))
    .filter((group) => group.items.length > 0)
}

/**
 * The research tool set as one account's runtime has it: the tools grouped, one sentence each, without what it is not given.
 * @param {Iterable<string>} [declinedTools]
 * @returns {{ count: number, groups: { title: string, tools: string[] }[] }}
 */
export function listResearchTools(declinedTools = []) {
  const groups = researchToolGroups({ without: declinedTools })
  return { count: groups.reduce((sum, group) => sum + group.tools.length, 0), groups }
}

/**
 * The words of a skill the control plane lists under an inventory item (the LoopX entry skill): the item's own title and line,
 * for the skills page's row and its drawer. Null where no item names the skill.
 * @param {string} skill
 * @param {typeof RUNTIME_INVENTORY_WORDS} [words]
 * @returns {{ itemId: string, title: string, use: string, how: string, gate: ItemGate } | null}
 */
export function inventorySkillWords(skill, words = RUNTIME_INVENTORY_WORDS) {
  for (const [itemId, item] of Object.entries(words.items)) {
    if (item.skills.includes(skill)) return { itemId, title: item.title, use: item.use, how: item.how, gate: item.gate }
  }
  return null
}
