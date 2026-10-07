/**
 * What each tool of the research tool set does, in one sentence a researcher
 * can read, and the group the plugins page lists it under.
 *
 * Hidden knowledge: the tool names are the model's vocabulary
 * (`literature_search`, `vcr_simulate`) and never the reader's. The tool set is
 * one plugin to a researcher — 「医学研究工具集」 — and what it is worth saying
 * about it is what its tools can do, so the sentences are data
 * (`research-tools-zh.json`) beside the list they describe, and a test holds
 * the two equal: a tool published without a sentence fails there.
 *
 * Kept out of the domain's root export; the control plane reads it through
 * `@evimed/domain/research-tools` and hands the browser the finished groups.
 *
 * @module @evimed/domain/src/researchToolDisplay
 */

import table from './research-tools-zh.json' with { type: 'json' }

/** @typedef {{ group: string, use: string }} ResearchToolDisplay */

/** The groups the tools are listed under, in the order the page lists them. */
export const RESEARCH_TOOL_GROUPS = Object.freeze([...table.groups])

/** Every tool's sentence by base name. @type {Readonly<Record<string, Readonly<ResearchToolDisplay>>>} */
export const RESEARCH_TOOL_DISPLAY = Object.freeze(Object.fromEntries(
  Object.entries(/** @type {Record<string, ResearchToolDisplay>} */ (table.tools)).map(([name, row]) => [name, Object.freeze({ ...row })]),
))

/**
 * The tools grouped for display: each group's sentences in the order the table
 * lists them, groups in their own order, a group with no tool left out.
 * @returns {{ title: string, tools: string[] }[]}
 */
export function researchToolGroups() {
  return RESEARCH_TOOL_GROUPS
    .map((title) => ({ title, tools: Object.values(RESEARCH_TOOL_DISPLAY).filter((row) => row.group === title).map((row) => row.use) }))
    .filter((group) => group.tools.length > 0)
}
