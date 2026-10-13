// Loading the corpus and checking it: documents, questions and the reference key points behind them.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCitation } from './citations.mjs'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const CORPUS_DIR = join(ROOT, 'corpus')

/** What a topic must carry: five questions across documents and four about a single fact. */
export const QUESTIONS_PER_TOPIC = Object.freeze({ synthesis: 5, single: 4 })

/** The platform's document id, derived so the corpus rebuilds byte for byte: src_ + 32 hex of sha256('<topic>/<pmid>'). */
export function sourceIdFor(topic, pmid) {
  return `src_${createHash('sha256').update(`${topic}/${pmid}`).digest('hex').slice(0, 32)}`
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex')

/** Whitespace-collapsed text, for the strict "verbatim" comparison of a reference quote. */
export const collapse = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/** @returns {Promise<Array<{ id: string, title: string }>>} */
export async function listTopics() {
  const { topics } = JSON.parse(await readFile(join(CORPUS_DIR, 'topics.json'), 'utf8'))
  return topics
}

/**
 * One topic as the harness uses it.
 * @returns {Promise<{ id: string, title: string, documents: Array<{ key: string, sourceId: string, title: string, text: string, pmid: string, doi: string | null, journal: string, year: number }>, questions: any[] }>}
 */
export async function loadTopic(id) {
  const directory = join(CORPUS_DIR, id)
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  const documents = []
  for (const entry of manifest.documents) {
    const text = await readFile(join(directory, 'docs', `${entry.key}.txt`), 'utf8')
    documents.push({ ...entry, text })
  }
  const questions = JSON.parse(await readFile(join(directory, 'questions.json'), 'utf8')).questions
  return { id: manifest.topic, title: manifest.title, documents, questions }
}

export async function loadCorpus(only = null) {
  const topics = await listTopics()
  const loaded = []
  for (const topic of topics) if (!only || only.includes(topic.id)) loaded.push(await loadTopic(topic.id))
  return loaded
}

/**
 * Check a loaded topic. Every finding is a message naming the document or question; an empty list is a corpus that stands.
 * @param {Awaited<ReturnType<typeof loadTopic>>} topic
 * @returns {string[]}
 */
export function checkTopic(topic) {
  const issues = []
  const byKey = new Map()
  const seenIds = new Set()
  for (const document of topic.documents) {
    if (byKey.has(document.key)) issues.push(`${topic.id}: document key ${document.key} appears twice`)
    byKey.set(document.key, document)
    if (document.sourceId !== sourceIdFor(topic.id, document.pmid)) issues.push(`${topic.id}/${document.key}: sourceId is not the derived one`)
    if (!/^src_[a-f0-9]{32}$/.test(document.sourceId)) issues.push(`${topic.id}/${document.key}: sourceId is not src_ + 32 hex`)
    if (seenIds.has(document.sourceId)) issues.push(`${topic.id}/${document.key}: sourceId repeats`)
    seenIds.add(document.sourceId)
    if (sha256(document.text) !== document.textSha256) issues.push(`${topic.id}/${document.key}: text does not match its recorded sha256`)
    if (document.text.length > 3000) issues.push(`${topic.id}/${document.key}: ${document.text.length} characters is over the ~2500 character budget`)
    for (const field of ['pmid', 'title', 'journal', 'year', 'url']) if (!document[field]) issues.push(`${topic.id}/${document.key}: missing ${field}`)
  }
  if (topic.documents.length < 5 || topic.documents.length > 10) issues.push(`${topic.id}: ${topic.documents.length} documents, expected 5-10`)

  const counts = { synthesis: 0, single: 0 }
  const questionIds = new Set()
  for (const question of topic.questions) {
    const where = `${topic.id}/${question.id}`
    if (!question.id || questionIds.has(question.id)) issues.push(`${where}: missing or repeated question id`)
    questionIds.add(question.id)
    if (!(question.kind in counts)) { issues.push(`${where}: kind must be synthesis or single`); continue }
    counts[question.kind] += 1
    if (typeof question.question !== 'string' || question.question.trim().length < 20) issues.push(`${where}: question text is missing`)
    const points = question.reference?.keyPoints
    if (!Array.isArray(points) || !points.length) { issues.push(`${where}: reference.keyPoints is empty`); continue }
    const pointIds = new Set()
    const docs = new Set()
    for (const point of points) {
      const at = `${where}/${point.id}`
      if (!point.id || pointIds.has(point.id)) issues.push(`${at}: missing or repeated key point id`)
      pointIds.add(point.id)
      if (typeof point.text !== 'string' || point.text.trim().length < 10) issues.push(`${at}: key point text is missing`)
      if (!Array.isArray(point.support) || !point.support.length) { issues.push(`${at}: a key point needs at least one support`); continue }
      for (const [position, support] of point.support.entries()) {
        const here = `${at}.support[${position}]`
        const document = byKey.get(support.doc)
        if (!document) { issues.push(`${here}: unknown document ${support.doc}`); continue }
        docs.add(support.doc)
        if (typeof support.quote !== 'string' || support.quote.length < 10) { issues.push(`${here}: quote is missing or shorter than 10 characters`); continue }
        if (!collapse(document.text).includes(collapse(support.quote))) issues.push(`${here}: quote is not verbatim in ${support.doc}: "${support.quote.slice(0, 70)}"`)
        const checked = checkCitation({ sourceId: document.sourceId, quote: support.quote }, (id) => (id === document.sourceId ? { text: document.text } : null))
        if (checked.status !== 'verified') issues.push(`${here}: the citation check an answer is held to says ${checked.status} for ${support.doc}`)
      }
    }
    if (question.kind === 'synthesis' && docs.size < 2) issues.push(`${where}: a synthesis question must draw on at least two documents, this one draws on ${docs.size}`)
    if (question.kind === 'single' && docs.size !== 1) issues.push(`${where}: a single-fact question must rest on exactly one document, this one on ${docs.size}`)
  }
  for (const [kind, want] of Object.entries(QUESTIONS_PER_TOPIC)) {
    if (counts[kind] !== want) issues.push(`${topic.id}: ${counts[kind]} ${kind} questions, expected ${want}`)
  }
  return issues
}

/** @returns {Promise<{ topics: number, documents: number, questions: number, issues: string[] }>} */
export async function checkCorpus(only = null) {
  const corpus = await loadCorpus(only)
  const issues = corpus.flatMap(checkTopic)
  if (corpus.length < 3 && !only) issues.push(`the corpus has ${corpus.length} topics, expected at least 3`)
  return {
    topics: corpus.length,
    documents: corpus.reduce((sum, topic) => sum + topic.documents.length, 0),
    questions: corpus.reduce((sum, topic) => sum + topic.questions.length, 0),
    issues,
  }
}
