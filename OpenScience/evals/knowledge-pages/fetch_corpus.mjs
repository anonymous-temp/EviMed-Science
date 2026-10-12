#!/usr/bin/env node
// Fetch the evaluation corpus once from PubMed (NCBI E-utilities) and write it under corpus/<topic>/.
// The files it writes are committed; after that the evaluation runs offline. Re-running overwrites them
// with whatever PubMed serves today, so check `git diff` and re-run `check_corpus.mjs` afterwards.
//
//   node fetch_corpus.mjs            # all topics in corpus/topics.json
//   node fetch_corpus.mjs <topic>    # one topic
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceIdFor } from './lib/corpus.mjs'

const ROOT = dirname(fileURLToPath(import.meta.url))
const EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
/** About 2500 characters per document; an abstract that runs over is cut at the last sentence end before the ceiling. */
export const MAX_TEXT_CHARS = 2800


const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole)
}

/** Text of an XML fragment: inner tags (<i>, <sup>, <sub>) are removed, entities decoded, whitespace collapsed. */
export function plainText(fragment) {
  return decodeXml(String(fragment).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
}

export function parseArticle(block) {
  const pick = (re) => { const m = re.exec(block); return m ? m[1] : '' }
  const pmid = plainText(pick(/<PMID[^>]*>(\d+)<\/PMID>/))
  const title = plainText(pick(/<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/))
  const journal = plainText(pick(/<Journal>[\s\S]*?<Title>([\s\S]*?)<\/Title>/))
  const pubDate = pick(/<JournalIssue[\s\S]*?<PubDate>([\s\S]*?)<\/PubDate>/)
  const year = (/<Year>(\d{4})<\/Year>/.exec(pubDate) ?? /(\d{4})/.exec(pubDate) ?? [])[1] ?? ''
  const doi = plainText(pick(/<ArticleId IdType="doi">([\s\S]*?)<\/ArticleId>/))
  const copyright = plainText(pick(/<CopyrightInformation>([\s\S]*?)<\/CopyrightInformation>/))
  const publicationTypes = [...block.matchAll(/<PublicationType[^>]*>([\s\S]*?)<\/PublicationType>/g)].map((m) => plainText(m[1]))
  const sections = [...block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)].map((m) => {
    const label = /Label="([^"]*)"/.exec(m[1])?.[1] ?? ''
    return { label: plainText(label).toUpperCase(), text: plainText(m[2]) }
  }).filter((section) => section.text)
  return { pmid, title, journal, year, doi, copyright, publicationTypes, sections }
}

/** The text a document is made of: title, one citation line, then the labelled abstract. */
export function documentText(article) {
  const citation = `${article.journal} (${article.year}). PMID ${article.pmid}.${article.doi ? ` DOI ${article.doi}.` : ''}`
  const body = article.sections.map((section) => (section.label ? `${section.label}: ${section.text}` : section.text)).join('\n')
  const full = `${article.title}\n${citation}\n\n${body}`
  if (full.length <= MAX_TEXT_CHARS) return { text: full, truncatedFrom: null }
  const head = full.slice(0, MAX_TEXT_CHARS)
  const cut = Math.max(head.lastIndexOf('. '), head.lastIndexOf('.\n'))
  return { text: head.slice(0, cut + 1), truncatedFrom: full.length }
}

async function efetch(pmids) {
  const url = `${EFETCH}?db=pubmed&id=${pmids.join(',')}&rettype=abstract&retmode=xml&tool=evimed-knowledge-pages-eval`
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(url)
    if (response.ok) return response.text()
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt))
  }
  throw new Error('PubMed efetch failed after four attempts')
}

async function main() {
  const { topics } = JSON.parse(await readFile(join(ROOT, 'corpus', 'topics.json'), 'utf8'))
  const only = process.argv[2]
  for (const topic of topics.filter((entry) => !only || entry.id === only)) {
    const xml = await efetch(topic.pmids)
    const articles = new Map()
    for (const block of xml.split('<PubmedArticle>').slice(1)) {
      const article = parseArticle(block)
      articles.set(article.pmid, article)
    }
    const directory = join(ROOT, 'corpus', topic.id)
    await mkdir(join(directory, 'docs'), { recursive: true })
    const documents = []
    for (const pmid of topic.pmids) {
      const article = articles.get(pmid)
      if (!article || !article.sections.length) throw new Error(`PMID ${pmid} came back without an abstract`)
      const { text, truncatedFrom } = documentText(article)
      const key = `pmid-${pmid}`
      await writeFile(join(directory, 'docs', `${key}.txt`), `${text}\n`, 'utf8')
      documents.push({
        key,
        sourceId: sourceIdFor(topic.id, pmid),
        pmid,
        doi: article.doi || null,
        title: article.title,
        journal: article.journal,
        year: Number(article.year),
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
        retrievedFrom: `${EFETCH}?db=pubmed&id=${pmid}&rettype=abstract&retmode=xml`,
        publicationTypes: article.publicationTypes,
        license: article.copyright || 'Abstract as indexed by PubMed (NLM). Copyright remains with the publisher; kept here only as a short excerpt for offline evaluation, with the citation above.',
        chars: text.length,
        truncatedFrom,
        textSha256: createHash('sha256').update(`${text}\n`).digest('hex'),
      })
    }
    const manifest = {
      schemaVersion: 1,
      topic: topic.id,
      title: topic.title,
      source: 'PubMed abstracts via NCBI E-utilities (efetch, retmode=xml)',
      fetchedAt: new Date().toISOString().slice(0, 10),
      documents,
    }
    await writeFile(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    console.log(`${topic.id}: ${documents.length} documents, ${documents.map((d) => d.chars).join('/')} chars`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
