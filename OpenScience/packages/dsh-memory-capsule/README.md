# Memory capsule for DSH

[中文](README.zh.md) · English

A thin, opt-in connector to an EviMed account's memory, facts and methods through
`/api/agent-memory/v1`. It has no storage, model calls, transcript collection,
workspace dependencies or runtime npm dependencies. Cordis supplies `tools` and
`systemPrompt` by injection; the module imports only Node's file API and uses
Node's native fetch. It does not load the EviMed universal preset or socket.

**Release candidate, not published.** `private: true` prevents accidental npm
publication. TODO: the owner decides whether, where and when to publish; only
then remove `private`, choose a release version, update the example index's
actual publication time and source, and perform a clean-profile installation.
No npm package or hosted index is claimed to exist today.

## From zero to recall

1. Use DSH `0.2.2-rc.1` on Node `>=24.9.0`. The exact DSH range is deliberately
   the approved runtime pin in `OpenScience/deps-version.json`, whose contracts
   were inspected; no compatibility with another preview release is claimed.
2. Sign into a deployment whose operator enabled the external memory API. Open
   `/app/account` → “外部智能体访问（API 密钥）” → “创建密钥”. Give it a name and
   select “读取记忆与做法”; also select “提出待确认的记忆” if you need proposals.
   Management and prescription-observation scopes are not needed by this plugin.
3. Copy the secret shown **once** into a local file with a text editor, then close
   the one-time display. Use a file outside repositories, restrict it to your OS
   account (for example `chmod 600 /absolute/path/evimed-key.txt` on Unix), and
   configure only its absolute path. Never put the secret in a command or YAML.
4. After the owner publishes the package, install it into the profile you use:

   ```sh
   dsh plugin --profile web add @evimed/dsh-memory-capsule@0.1.0
   ```

   For a local review before publication, install the supplied package directory
   or owner-supplied tarball with the same command's `add <local-path>` form.
   Installing may require network access by DSH's package manager; no installation
   is performed by this repository's check scripts.
5. Add this override to `$DSH_HOME/profiles/web/cordis.patch.yml` (use your actual
   profile). The bundle already inserts the single plugin; do not insert it twice.

   ```yaml
   - id: evimed-memory-capsule
     config:
       baseUrl: 'https://your-evimed-deployment.example'
       apiKeyFile: '/absolute/path/evimed-key.txt'
   ```

   `baseUrl` is unset by default; use the deployment origin, or that origin plus
   `/api/agent-memory/v1`. HTTP is supported only on localhost. The file is read
   again for every request, so replacing it rotates the credential without a
   restart. Other config fields, including inline keys, are refused. This small
   plugin is configured through YAML; it provides no configuration form.
6. Restart that profile (or let its enabled HMR reload it). Ask the agent to call
   `capsule_status`, then `capsule_recall` with a concrete question about your
   earlier work. An empty recall is a valid result. Status reports reachability,
   scopes, project binding and that the key speaks for its creating account;
   the public API does not disclose the account's name or ID.

Revoke a key in the same account section. Create another and replace the local
file to restore access. Revoked keys cannot be shown or recovered.

## Tools and limits

| Tool | What it does |
|---|---|
| `capsule_recall` | Queries memories and capsule facts, with method cards including `whenToUse` when the API provides it; method bodies are omitted. Optional `projectId` and `limit` keep the API's scope. |
| `capsule_propose` | Posts `factKind`, `content`, optional `projectId` to `/note`; pending until the person confirms it on the web memory page. It never confirms or activates anything. |
| `capsule_method` | Fetches the **current** recall catalog and returns one method body by `digest` or exact `name` (ID/title/name). Duplicate names require a digest. |
| `capsule_status` | Checks configuration and the API's key-capability endpoint. |

The public recall API currently returns bodies within its bounded method
catalog. The connector strips them from recall and re-requests the current
catalog for a method read; it does not cache stale bodies or invent a body-by-
digest HTTP route. Methods outside that current catalog/budget are unavailable.
When both selectors are supplied, the digest selects the method.

There is **no raw conversation-history recall**, automatic transcript upload,
external-work learning, method mounting, capsule selection/isolation or local
memory engine here. **Forget and share stay on the web memory page**
(`/app/memory`); proposals are confirmed there too. Memory and methods are
context, not authority. General writing, documents, code and everyday work do
not require a recall; unavailable memory never blocks them.

Missing configuration points to the key page. Connection failures, 401, 403,
429 and disabled/unavailable 503 responses are plain sentences; response error
bodies and exception traces are not exposed. Requests time out after 15 seconds,
do not follow redirects and do not retry writes. Disposal aborts active requests
and releases registered Cordis tools and the prompt section. No key is logged.

## Example market index and local checks

`market-index.example.json` is a **format-1 example**, not a live market listing.
It names an unpublished npm target; its timestamp is illustrative. A custom
index is optional for discovery and must be hosted/published by the owner after
release. Direct package installation does not need an index. DSH's experimental
market discovery needs its own enablement and configured custom index; this
package does not enable or host it.

```sh
node --test test/plugin.test.mjs
node scripts/check-index.mjs [absolute-path-to-dsh-install]
node scripts/check-bundle.mjs [absolute-path-to-dsh-install]
```

The last two scripts import DSH's own format-1 validator and read-only boot
readers from the approved installation (default recorded in each script). They
validate the actual index, exported locales, YAML insertion/override and exact
compatibility, without installing, publishing or booting a profile. The unit
suite uses a loopback fake HTTP service and disposable test credentials only.
