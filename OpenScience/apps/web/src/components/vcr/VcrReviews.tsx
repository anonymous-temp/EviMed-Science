import type { VcrReviewSummary } from '@/lib/vcrClient';

/** Both independent AI perspectives remain advice; optional human notes stay attributable. */
export function VcrReviews({ reviews = [] }: { reviews?: VcrReviewSummary[] }) {
  if (!reviews.length) return null;
  return <section aria-label="研究复核" className="mt-6 space-y-3">
    <h3 className="text-section font-semibold text-text">研究复核</h3>
    {reviews.slice(0, 6).map(review => <article key={review.id} className="rounded-card border border-border p-4">
      <p className="text-ui font-medium text-text">{review.label} · {review.state}</p>
      <p className="mt-1 text-caption text-text-3">{[review.by, review.at].filter(Boolean).join(' · ')}</p>
      <p className="mt-1 text-caption text-text-2">{review.note}</p>
      {review.findings.length > 0 && <ul className="mt-2 space-y-2">
        {review.findings.map((finding, index) => <li key={finding.id ?? index} className="text-ui text-text-2">
          {finding.location && <span className="font-medium">{finding.location}： </span>}{finding.fix || finding.message}
          {finding.evidence && <blockquote className="mt-1 text-caption text-text-3">{finding.evidence}</blockquote>}
        </li>)}
      </ul>}
    </article>)}
  </section>;
}
