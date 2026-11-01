# EviMed DSH search topics

An independent, dependency-free DSH plugin bundle exposing the medical-search
homepage's topic cards over HTTP. It mounts a named route on DSH's existing
`webServer` service, uses no model, and opens no listener of its own.

The four categories are `literature`, `guidelines`, `drugs`, and `trials`.
Topics come from an operator-owned JSON snapshot, read on every request. The
package does not collect personal searches, query a clinical database, call a
model, or manufacture popularity. Its portable examples remain explicitly
marked examples. EviMed's optional control-plane publisher now creates real
global recommendations from the existing published frontier corpus and a bounded
sample of official ClinicalTrials.gov updates, preserving the basis and source
references described below. A separate installation can publish the same
contract from its own recommendation provider.

## Visibility in EviMed

Creating or downloading this tarball does not install it. A standalone DSH
installation and EviMed's **Plugins and Skills** center have separate inventories.
EviMed's current user-extension installer does not accept local tarballs or
activate native HTTP host plugins. Installing this bundle in a separate DSH
profile therefore does not add it to EviMed's list. EviMed's runtime image can
ship it as the optional built-in **Search Topic Suggestions** plugin. The
control plane lists that plugin only after confirming its configured data source
and an installed plugin version of at least 0.2.0; an older running runtime must
finish its current work before it can be replaced. Adding a catalogue label
alone does not make the service available.

## Install in a separate local DSH profile

Requires Node as declared in `package.json`, a DSH installation with the native
`webServer.register` service, and a web-based profile. The packaged manifest's
`engines.dsh` and `compatibility.json` derive from the repository's one kernel
pin; compatibility with other kernels has not been established.

Extract the tarball into a reference folder to access its examples (keep the
original tarball for installation):

```sh
mkdir -p ./search-topics-package
tar -xzf ./evimed-dsh-search-topics-0.2.0.tgz -C ./search-topics-package
mkdir -p "$HOME/.config/evimed-search-topics"
chmod 700 "$HOME/.config/evimed-search-topics"
export EVIMED_SEARCH_TOPICS_FILE="$HOME/.config/evimed-search-topics/topics.json"
export EVIMED_SEARCH_TOPICS_TOKEN_FILE="$HOME/.config/evimed-search-topics/service-token"
export EVIMED_SEARCH_TOPICS_ENABLED=1
cp ./search-topics-package/package/examples/topics.example.json "$EVIMED_SEARCH_TOPICS_FILE"
node --input-type=module -e '
  import { randomBytes } from "node:crypto";
  import { writeFileSync } from "node:fs";
  writeFileSync(process.env.EVIMED_SEARCH_TOPICS_TOKEN_FILE,
    randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
'
```

Use an unused profile name. The following initialization replaces that named
profile with a clean web template; do not run it against an existing work profile.

```sh
dsh --profile search-topics-demo --from-default-profile web --dump-config >/dev/null
dsh plugin --profile search-topics-demo add /absolute/path/evimed-dsh-search-topics-0.2.0.tgz
dsh --profile search-topics-demo --no-open --host 127.0.0.1 --port 3000
```

Keep these environment variables in the launch environment. The plugin is
disabled unless `EVIMED_SEARCH_TOPICS_ENABLED=1`. Missing or
relative file paths reject plugin activation. A profile patch can override
`topicsFile` and `tokenFile` on row `evimed-search-topics` instead. No application
database credentials or model provider keys are used. The service token is a
new plugin credential, not the account's EviMed login token.

In another terminal with the token-file variable set:

```sh
node ./search-topics-package/package/examples/request.mjs literature
```

## API

`GET /api/evimed-search/topics?category=literature&limit=3`

Required header: `Authorization: Bearer <service token>`. Keep this token on the
server. `category` is required; `limit` defaults to 3 and accepts integers 1–12.
Duplicate and unknown parameters are rejected. See `openapi.json` for the contract.

A successful response has this shape (revision abbreviated here):

```json
{
  "schemaVersion": 1,
  "category": "literature",
  "topics": [{ "id": "hypertension", "query": "高血压", "description": "血压管理与心血管风险" }],
  "count": 1,
  "total": 1,
  "updatedAt": null,
  "revision": "<sha256 of the source snapshot>",
  "source": { "kind": "curated", "label": "Example search prompts", "isExample": true }
}
```

`count` is the number returned; `total` is the selected category's size.
`updatedAt` is the publisher's UTC timestamp, or `null` when unknown, not the
request time. Ordering is the publisher's ordering. No score or popularity is
inferred. Empty categories return HTTP 200 with `topics: []`, `count: 0`, and
`total: 0`. Every response uses `Cache-Control: no-store`.

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid category, limit, or parameters. |
| 401 | `unauthorized` | Missing or incorrect service token. |
| 405 | `method_not_allowed` | Only GET is supported. |
| 503 | `topics_auth_unavailable` | Token file unreadable or invalid. |
| 503 | `topics_unavailable` | Source unreadable, oversized, malformed, or invalid. |

Errors never contain filesystem paths, source bytes or credentials. A failed
native read never substitutes example data or a cached response. An explicitly
published stale snapshot can be served with `recommendation.stale: true`; its
original generation time and citations stay intact.

## Source-backed recommendations

A source-backed feed adds `recommendation` to `TopicFeed` and the selected
response, and `basis` to every topic. The source must be `kind: "provider"` and
`isExample: false`; a provider cannot label unreferenced example prompts as
recommendations. Curated feeds without these optional fields remain supported.
Unknown fields are discarded at the native and control-plane boundaries by the
same exported `@evimed/dsh-search-topics/contract` validator.

| Field | Meaning |
| --- | --- |
| `recommendation.algorithm` | `recent-medical-topics-v1`. |
| `recommendation.windowDays` | 30. |
| `recommendation.generatedAt` | The snapshot's actual UTC publication instant, equal to `updatedAt`. |
| `recommendation.dataThrough` | Latest source timeline represented by the retained topics, or null for an empty feed; never newer than generation. |
| `recommendation.stale` | A failed refresh is explicitly serving the previous real snapshot. Its generation time is unchanged. |
| `recommendation.corpusVersion` | Publisher's nonempty corpus-generation identity, at most 160 UTF-16 code units. |
| `basis.eventCount` | Distinct collected events for this topic and category in the stated window, 1–100,000. |
| `basis.sourceCount` | Distinct reporting institutions in that corpus, 1–100,000; one event can have several sources. |
| `basis.latestAt` | Latest qualifying collected timeline for the topic; no newer than `dataThrough` or `generatedAt`. |
| `basis.sources` | 1–3 preserved source references; this sample is not an exhaustive list of events or institutions. |

Each reference contains a stable `id` (same syntax as topic ids), `title`
(1–200 code units), `url` (at most 2,048), `source` (1–120), `publishedAt`
(UTC instant or null), `timelineAt` (UTC instant), and
`dateBasis: "published" | "observed" | "updated"`. An observed date retains a null
`publishedAt`; it never invents publication time from ingestion time. A registry's
last-update date uses `updated`, preserves its actual update instant in
`timelineAt` (a source date is normalized to its UTC day), and also keeps
`publishedAt: null`. It is neither a publication date nor our observation time.
Published basis requires a known publication date. Each cited timeline must be inside the
30 days ending at `generatedAt`, and neither its timeline nor a known publication
date can be newer than the topic's `latestAt`. Reference ids are unique per topic.
Times accept UTC seconds or exactly three millisecond digits, and reject impossible
calendar dates. Text is trimmed and contains no ASCII controls. Citation addresses
must be HTTP(S) public domain-name URLs without credentials, whitespace or
backslashes; local/internal/test names, single-label hosts and IP literals are
refused. The plugin validates addresses but never fetches them or performs DNS.
The complete snapshot still has the 256 KiB limit, including all references.

These counts describe the publisher's collected corpus. They are not the number
of results in the medical-search index, clinical evidence quality, user search
volume, or proof of a drug's suitability. Clicking a topic only fills the search
input.

## EviMed's current global ranking

The control plane reads existing `evimed_frontier` data and the official public
ClinicalTrials.gov API. Neither source requires a new provider key or model
call, and no user searches, history, profile or project content enter the ranking.
The frontier contribution considers only published items from enabled,
non-retired, externally produced sources with a timeline inside the past 30 days.
Only active controlled tags are eligible there; merged tags resolve to their
active target, and duplicate item/tag links are removed.

Categories have separate eligibility: literature uses journal/preprint content
with disease or concrete-drug tags; guidelines use guideline channel, genre or
evidence type with disease tags; drugs use concrete-drug tags. A disease mentioned
in an ordinary article does not become a registered-trial suggestion.

The clinical-trial category uses only the official ClinicalTrials.gov source;
untyped frontier registry entries cannot enter it. The source requests recently
updated `INTERVENTIONAL` study registrations, ordered by official
`LastUpdatePostDate` descending, within the last 30 days. It reads one bounded
page: 100 studies by default, with a helper
limit of 200, and never follows the next-page token. This is a sample of recent
updates, not a ranking of the entire registry or proof of recruitment status.
Invalid NCT identifiers, impossible, old or future dates, duplicate records and
unreadable nonempty answers are refused; a truly empty answer remains empty.
Conditions stated in those records form the topics. Exact aliases of active
controlled disease tags use the shared name; unmatched conditions keep their
registered spelling without a model-generated translation. Each distinct NCT
registration counts once per condition; the registry is one reporting source,
not a count of sponsors. Its references link to the original study pages and
use `dateBasis: "updated"`, `publishedAt: null`, and the actual registry update
date normalized to a UTC day. Update frequency is not evidence of trial quality
or results.

Within each category and tag, reports of the same event count once. Its activity
is the sum of `2 ** (-ageInDays / 7)` over those events: a seven-day half-life.
Clinical-trial conditions use the same decay over distinct registrations in the
bounded sample, with age measured from each actual registry update date.
Ordering is activity descending, independent institution count descending,
latest timeline descending, then stable tag id. Tags whose sets of up to 50
recent event identities have Jaccard overlap of at least 0.7 are diversified,
so the same evidence does not occupy all three homepage slots. The feed keeps
at most 12 topics per category; the homepage requests three. References sample
up to three recent distinct events. Long reference URLs may reduce the number
of retained references or trailing topics to keep the byte limit; retained
corpus counts are not altered to match that display sample.

One global refresh serves all accounts and categories. On an authenticated
project read, the publisher refreshes after five minutes or a change of the
frontier content/tag generation. A shared in-flight promise and a PostgreSQL
advisory transaction lock prevent duplicate publication. The public API read
finishes before a database transaction or publication lock is held. The public
transport pins checked DNS addresses, rejects private destinations and redirects,
and bounds the response bytes and request deadline. An atomic file rename
updates already-mounted runtimes. If either source or publication fails, a valid
real provider snapshot no older than 24 hours can be returned explicitly as stale; examples
never qualify. With no valid recovery snapshot the API fails and manual search
remains available. With no qualifying source content the category is empty.
The recommendations reflect the collected frontier corpus and its ingestion
timing, plus the bounded clinical-trial update sample, not a promise to cover
every publication or registered study worldwide.

## Publish actual topics

Start from `examples/topics.empty.json`. Fill the category arrays, preserve
all four keys, and set `source.isExample` to false only for your own published
content. Set `source.kind` to `curated` or `provider` and give it an honest label.
Set `updatedAt` to the actual publication time as UTC ISO 8601, or null if unknown.

Each category accepts at most 100 topics. Each topic requires a stable lowercase
ASCII id (1–64 characters, letters, digits, `_` or `-`), a query (1–160 UTF-16
code units), and a description (1–240 code units). IDs must be unique within a
category. Text must be trimmed and free of control characters. The file must be
a regular file no larger than 256 KiB. Source labels have a 120-code-unit limit.

Write a complete temporary file beside the current one, then atomically rename
it over `topics.json`. The next request reads that snapshot without restarting
DSH. Replace the token file the same way to rotate its 32–512-character
base64url/hex service token; old tokens stop working on subsequent requests.
In-flight requests can finish against the snapshot they already opened.

## EviMed integration boundary

The EviMed browser calls `apps/server`, and that control plane calls this route
with its service token. The browser must never reach the kernel directly or
receive this token. Render descriptions as plain text. Preserve separate loading,
empty, failure and success states, and identify example data in any demo UI.
Selecting a topic may fill the search input without automatically submitting it,
matching the current homepage's behavior.

For hosted runtimes, install the bundle while building the runtime image and
mount the operator's snapshot read-only; keep the token in control-plane-managed
credentials outside the workspace. Do not enable plugin management
or HMR in a serving research runtime. Use a server-side private connection or TLS
when leaving loopback. The built-in EviMed integration is opt-in with
`OPEN_SCIENCE_SEARCH_TOPICS_ENABLED=true` and uses the control plane's
`.openscience/search-topics/topics.json` source snapshot. Its separate per-runtime
service token is created by the control plane and never sent to the browser.
The authenticated browser route is
`GET /api/projects/:projectId/evimed-search/topics?category=literature&limit=3`.

## Source verification and packaging

From this package directory in the EviMed monorepo:

```sh
pnpm test
pnpm lint
pnpm typecheck
pnpm pack:plugin
```

The pack script uses an explicit file list, excludes development scripts and
tests from the published manifest, derives kernel compatibility from
`deps-version.json`, and writes the tarball plus a SHA-256 sidecar under the
workspace's ignored `outputs/dsh-search-topics/`. No registry publication occurs.
