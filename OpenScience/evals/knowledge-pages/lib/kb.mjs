// The knowledge base a question is asked of: which documents, and for arm C which compiled pages, are in the search index.
import { ARMS, ARM_B_REMOVED } from './prompts.mjs'
import { buildIndex } from './retrieval.mjs'
import { treeForRep, upstreamPageRecords } from './upstream.mjs'

/** @param {{ documents: Array<{ sourceId: string, title: string, text: string }> }} topic */
export function documentRecords(topic) {
  return topic.documents.map((document) => ({ id: document.sourceId, kind: 'document', title: document.title, text: document.text }))
}

/**
 * The tree each topic of a question's knowledge base contributes in one repetition, by topic id.
 *  - scope `topic`: the project is the question's topic, so one tree;
 *  - scope `pooled`: the project holds every selected topic, so one tree of each.
 * Null when one of them has no tree: the pages are part of what arm C is, and a cell asked without them would be arm A.
 * @param {{ scope: 'topic' | 'pooled', topic: any, corpus: any[], trees: Map<string, any[]>, rep: number }} options
 * @returns {Record<string, { name: string, pages: Array<{ path: string, content: string }> }> | null}
 */
export function treesFor({ scope, topic, corpus, trees, rep }) {
  const chosen = {}
  for (const member of scope === 'pooled' ? corpus : [topic]) {
    const tree = treeForRep(trees.get(member.id) ?? [], rep)
    if (!tree) return null
    chosen[member.id] = tree
  }
  return chosen
}

/**
 * The index for one question: the documents of its project and, in arm C, the pages compiled from them — every page file a
 * searchable document beside the originals, as in the product. In a pooled project page ids carry the topic, because two
 * topics may each have a page `entity/aspirin.md`.
 * @param {{ scope: 'topic' | 'pooled', arm: string, topic: any, corpus: any[], trees?: Map<string, any[]>, rep: number }} options
 * @returns {import('./retrieval.mjs').Bm25Index | null}  null: arm C with no tree to search (see `treesFor`)
 */
export function buildKnowledgeBase({ scope, arm, topic, corpus, trees = new Map(), rep }) {
  if (!ARMS[arm]?.runnable) throw new Error(arm === 'B' ? ARM_B_REMOVED : `unknown arm ${arm}`)
  const members = scope === 'pooled' ? corpus : [topic]
  const records = members.flatMap(documentRecords)
  if (ARMS[arm].pages) {
    const chosen = treesFor({ scope, topic, corpus, trees, rep })
    if (!chosen) return null
    for (const member of members) {
      records.push(...upstreamPageRecords(chosen[member.id], {
        documentIds: new Set(member.documents.map((document) => document.sourceId)),
        prefix: scope === 'pooled' ? `${member.id}/` : '',
      }))
    }
  }
  return buildIndex(records)
}
