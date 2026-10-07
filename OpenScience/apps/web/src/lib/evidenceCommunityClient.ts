import { productRequest } from "./productClient";

/** One user-published card on the same subjects as an official zone, as the community column lists it. Read-only: the platform never edits it. */
export interface EvidenceCommunityCard {
  id: string;
  zoneId: string;
  zoneTitle: string;
  title: string;
  summary: string;
  author: { id: string; name: string };
  producer: { kind: string; name: string } | null;
  originality: string | null;
  /** Claims found in their sources, of all the card's claims. */
  claims: { total: number; verified: number };
  verifiedShare: number | null;
  /** The readers' average score of the card's current revision, and how many scored it. */
  reviewScore: number | null;
  reviews: number;
  sharedKeys: string[];
  updatedAt: string;
}
export interface EvidenceCommunityColumn { zoneId: string; entityKeys: string[]; items: EvidenceCommunityCard[]; limit: number }

/** The community column of an official zone. Answers 404 `evidence_community_not_enabled` where the deployment has not switched it on. */
export async function fetchEvidenceCommunity(zoneId: string): Promise<EvidenceCommunityColumn> {
  return productRequest<EvidenceCommunityColumn>(`/frontier/zones/${encodeURIComponent(zoneId)}/community`);
}
