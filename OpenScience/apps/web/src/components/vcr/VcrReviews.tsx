import { Link } from 'react-router';
import type { VcrReviewSummary, VcrTabKey } from '@/lib/vcrClient';
import { isVcrTab, vcrTabPath } from './vcrTabs';

/**
 * Where a finding's object is read: its tab, and for an assumption the card (`?card=`, which the definition tab opens). The server sends a
 * target only for an object the study has; a tab name this build does not know is no link.
 */
function targetPath(studyId: string, target: { tab: string; key?: string | null }): string | null {
  if (!isVcrTab(target.tab)) return null;
  return `${vcrTabPath(studyId, target.tab as VcrTabKey)}${target.key ? `?card=${encodeURIComponent(target.key)}` : ''}`;
}

/**
 * Both independent AI perspectives remain advice; optional human notes stay attributable.
 *
 * A finding is its one actionable sentence and, when it is about an object the study holds, the way to that object. The reviewer's
 * path into the frozen snapshot, the JSON it quoted and the timestamp of its record are the review's own provenance and never printed.
 */
export function VcrReviews({ reviews = [], studyId, onNavigate }: { reviews?: VcrReviewSummary[]; studyId?: string; onNavigate?: () => void }) {
  if (!reviews.length) return null;
  return <section aria-label="研究复核" className="mt-6 space-y-3">
    <h3 className="text-section font-semibold text-text">研究复核</h3>
    {reviews.slice(0, 6).map(review => <article key={review.id} className="rounded-card border border-border p-4">
      <p className="text-ui font-medium text-text">{review.label} · {review.state}</p>
      <p className="mt-1 text-caption text-text-3">{[review.by, review.at].filter(Boolean).join(' · ')}</p>
      <p className="mt-1 text-caption text-text-2">{review.note}</p>
      {review.findings.length > 0 && <ul className="mt-2 space-y-2">
        {review.findings.map((finding, index) => {
          const path = studyId && finding.target ? targetPath(studyId, finding.target) : null;
          return <li key={finding.id ?? index} className="text-ui text-text-2">
            {finding.fix || finding.message}
            {path && finding.target && <> <Link to={path} onClick={onNavigate} className="text-link hover:underline">{`查看${finding.target.label}`}</Link></>}
          </li>;
        })}
      </ul>}
    </article>)}
  </section>;
}
