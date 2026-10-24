import { productRequest } from "./productClient";

/**
 * 与我相关's onboarding answer (`GET`/`PUT /api/frontier/prefs`, ct-track 2026-10-24): the reader's role, one to three
 * specialties, up to ten interests (tag slugs of the tree, or entity keys), and when it was finished or skipped. The ranking
 * that reads it is the server's; this is only the answer.
 */
export interface FrontierPrefs {
  role: string | null;
  specialties: string[];
  interests: string[];
  /** The tags among the interests, named as the tree names them now. */
  interestTags: Array<{ slug: string; name: string }>;
  onboardedAt: string | null;
  skippedAt: string | null;
}

/** What may be saved; a field not sent is left as it is. `done` finishes the answer, `skipped` skips it. */
export interface FrontierPrefsUpdate {
  role?: string | null;
  specialties?: string[];
  interests?: string[];
  done?: boolean;
  skipped?: boolean;
}

function parsePrefs(value: unknown): FrontierPrefs {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const words = (list: unknown) => (Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : []);
  const when = (entry: unknown) => (typeof entry === "string" && entry ? entry : null);
  return {
    role: typeof raw.role === "string" ? raw.role : null,
    specialties: words(raw.specialties),
    interests: words(raw.interests),
    interestTags: (Array.isArray(raw.interestTags) ? raw.interestTags : []).flatMap((entry) => {
      const tag = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      return typeof tag.slug === "string" && typeof tag.name === "string" ? [{ slug: tag.slug, name: tag.name }] : [];
    }),
    onboardedAt: when(raw.onboardedAt),
    skippedAt: when(raw.skippedAt),
  };
}

export async function fetchFrontierPrefs(): Promise<FrontierPrefs> {
  return parsePrefs(await productRequest<unknown>("/frontier/prefs"));
}

export async function saveFrontierPrefs(update: FrontierPrefsUpdate): Promise<FrontierPrefs> {
  return parsePrefs(await productRequest<unknown>("/frontier/prefs", "PUT", update));
}
