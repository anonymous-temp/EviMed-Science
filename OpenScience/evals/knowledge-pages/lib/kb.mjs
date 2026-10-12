// The knowledge base a question is asked of: which documents, and for arm B which compiled pages, are in the search index.
import { buildIndex } from './retrieval.mjs'

export const INDEX_TITLE = '知识页目录'

/** @param {{ documents: Array<{ sourceId: string, title: string, text: string }> }} topic */
export function documentRecords(topic) {
  return topic.documents.map((document) => ({ id: document.sourceId, kind: 'document', title: document.title, text: document.text }))
}

/**
 * The page files of a compile as searchable documents: ids `page:<prefix><slug>`, so a model that cites a page can be told from one
 * that cites a document, and the index page beside them (it is a file of the wiki folder like any other).
 * @param {{ pages: Array<{ slug: string, title: string, markdown: string }>, indexMarkdown?: string }} compiledTopic @param {string} [prefix]
 */
export function pageRecords(compiledTopic, prefix = '') {
  const records = compiledTopic.pages.map((page) => ({ id: `page:${prefix}${page.slug}`, kind: 'page', title: page.title, text: page.markdown }))
  if (compiledTopic.indexMarkdown) records.push({ id: `page:${prefix}index`, kind: 'page', title: INDEX_TITLE, text: compiledTopic.indexMarkdown })
  return records
}

/**
 * The index for one question.
 *  - scope `topic`: the project is the question's topic: its documents, and for arm B its pages.
 *  - scope `pooled`: the project holds every selected topic: all their documents, and for arm B all their pages
 *    (page ids carry the topic, because two topics may each have a page `aspirin`).
 * @param {{ scope: 'topic' | 'pooled', arm: string, topic: any, corpus: any[], compiled: Map<string, any>, rep: number }} options
 */
export function buildKnowledgeBase({ scope, arm, topic, corpus, compiled, rep }) {
  if (scope === 'pooled') {
    const records = corpus.flatMap(documentRecords)
    if (arm === 'B') for (const entry of corpus) records.push(...pageRecords(compiled.get(`${entry.id}/${rep}`), `${entry.id}/`))
    return buildIndex(records)
  }
  const records = documentRecords(topic)
  if (arm === 'B') records.push(...pageRecords(compiled.get(`${topic.id}/${rep}`)))
  return buildIndex(records)
}
