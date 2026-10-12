#!/usr/bin/env node
// check_corpus: every document is the recorded one, and every quote behind a reference key point is verbatim in the
// document it names. Exit code 1 on any finding.
import { checkCorpus } from './lib/corpus.mjs'

const only = process.argv.slice(2)
const report = await checkCorpus(only.length ? only : null)
for (const issue of report.issues) console.error(`ISSUE ${issue}`)
console.log(`${report.topics} topics, ${report.documents} documents, ${report.questions} questions, ${report.issues.length} issues`)
process.exit(report.issues.length ? 1 : 0)
