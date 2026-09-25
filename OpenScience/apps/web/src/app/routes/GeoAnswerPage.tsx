import { useParams } from "react-router";

/** STUB — package D2 writes the real page (route `/app/geo/:geoId/answers/:snapshotId`); dropped at merge. */
export function GeoAnswerPage() {
  const { geoId, snapshotId } = useParams();
  return <div data-geo-answer-stub="" data-geo-id={geoId} data-snapshot={snapshotId} />;
}
