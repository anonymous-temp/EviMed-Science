// The answer protocol: reading the evimed-source comments an answer carries and checking each against the document it names.
import { checkKnowledgeEvidence } from '@evimed/domain'

const MARKER = /<!--\s*evimed-source:\s*(\{[^\n]{1,8000}?\})\s*-->/g

/**
 * Every evimed-source comment in a reply, as written (an id that is not a document id is kept, because citing a page or an
 * invented id is a failure to count, not a comment to skip).
 * @param {string} text @returns {Array<{ sourceId: string, quote: string }>}
 */
export function parseMarkers(text) {
  const found = []
  for (const match of String(text ?? '').matchAll(MARKER)) {
    try {
      const value = JSON.parse(match[1])
      found.push({ sourceId: typeof value?.sourceId === 'string' ? value.sourceId : '', quote: typeof value?.quote === 'string' ? value.quote : '' })
    } catch { found.push({ sourceId: '', quote: '' }) }
  }
  return found
}

/** The reply as a reader sees it: the comments are metadata. @param {string} text */
export function stripMarkers(text) {
  return String(text ?? '').replace(MARKER, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * The code check of a reply's citations: each marker against the document it names, by the platform's comparison. A marker
 * naming a knowledge page counts separately (`pageCited`) and, like any marker whose id is not a document's, does not verify.
 * @param {string} answer
 * @param {(sourceId: string) => { text: string } | null} resolve  documents only; pages and unknown ids resolve to null
 * @returns {{ markerCount: number, verified: number, verifiedRate: number | null, byStatus: Record<string, number>, pageCited: number }}
 */
export function checkAnswerCitations(answer, resolve) {
  const markers = parseMarkers(answer)
  const byStatus = {}
  let verified = 0
  let pageCited = 0
  for (const marker of markers) {
    if (marker.sourceId.startsWith('page:')) pageCited += 1
    const checked = checkKnowledgeEvidence(marker, resolve)
    byStatus[checked.status] = (byStatus[checked.status] ?? 0) + 1
    if (checked.status === 'verified') verified += 1
  }
  return { markerCount: markers.length, verified, verifiedRate: markers.length ? verified / markers.length : null, byStatus, pageCited }
}
