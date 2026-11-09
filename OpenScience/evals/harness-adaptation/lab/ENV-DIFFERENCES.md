# The RSI lab compared with production

What a benchmark item meets in a lane (a GitHub Actions job running the CI release images) and how that differs from production, as read on
2026-11-01 and updated on 2026-11-02 (round 2: the context engine and the document parser are on, the rest is listed with why it cannot be matched). The levers are the lab's `stack.py` (`PARITY`, `lab_overrides`) against production's non-secret levers
(`<production levers snapshot, operator only, never in this tree>`, read from production's `.env`: names without KEY, TOKEN, SECRET, PASSWORD, CREDENTIAL, URL or HOST); `python3 -I
env_diff.py` prints the comparison this document summarises. Anything production sets that is not listed here is a build-time pin, a
module the lab leaves off, or a lever the code does not forward to any container (`OPEN_SCIENCE_ENABLE_KERNEL` and the other `KERNEL_*`
levers, `TZ`: nothing reads them, in production either).

## The same

- The images: the CI full-release core subset of `5c740327bb8c` (web, runtime, result replay, drug-evidence adapter), loaded by digest-checked
  `docker load`; each role's image id is compared with the archive's record before anything starts. Production runs `77ba0a43657b`; the
  trees differ only in `check-tool-sandbox.sh` where the runtime, the socket, `deploy/runtime-dsh` and the server sources are concerned.
- `NODE_ENV=production`, the controlled-pilot profile, local authentication with self-registration, PostgreSQL (the pgvector image),
  the runtime controller behind its unix socket, runtimes launched by it on the internal network with no egress, read-only root, 2 CPUs,
  3 GB, 1024 pids, 64 MB `/tmp`, the sandbox enforcement the code demands in production.
- The context engine: OpenViking, the image exactly as `deps-version.json` pins it (`ghcr.io/volcengine/openviking:v0.5.3@sha256:57d3fd88…`,
  `stack.py openviking_image()`; a test holds it equal to the base stack's own default), with its `ov.conf` rendered by `configure:production-state` from the
  DashScope key, started before the web service as in production, memory on (`OPEN_SCIENCE_MEMORY_INDEX_PROVIDER=openviking`, the account `evimed`, the reranker and the
  recall budgets production sets). Every request is `automated` on a throwaway account, so the engine is handed no resident profile and no turn is committed to it, and the
  learning loop teaches nothing: `stack.py facts` reads the control plane's counters (`memoryTurnCommitted`, `learningRecorded`) into every result bundle's `lane.json`
  (`stack`), and a non-zero value is a defect.
- The document parser: the parser team's own service, over HTTP, wired the way the ingestion overlay wires it (`OPEN_SCIENCE_DOCUMENT_PARSER_URL`, `_TOKEN_FILE` empty,
  `_TIMEOUT_MS`, `_REVISION`, required as in production). Its address is the operator's and travels in the secret bundle (`document-parser.url`), not in this public tree.
  The control plane reads a PDF through it when a page it fetches is one (`web_read`, the open-access full-text path). `stack.py verify` asks its `/health` and parses a
  one-page PDF written in place, and records the answer (`stack.documentParser`) in every bundle. **Status on 2026-11-02 (batch b031): the address the operator's notes
  name (the parser team's test server) answers `/health` (`healthy`) but returns 404 for `/api/v1/extract/text/file` and `/api/v1/parse/file`, so the probe PDF is
  `source_parser_rejected` and a PDF read in the lab still has no parsed text. The wiring is verified, the address is not production's current one; the fix is the one line
  in the secret bundle (`document-parser.url`, then `make-bundle.sh`), and the next job's `stack.documentParser.parse.ok` says whether it took.**
- The model: `deepseek-flash`, reasoning effort `high`, LLM routing on at confidence 0.75, the model gateway's timeouts and body limits,
  the credits ledger (simulated, one credit per CNY, no spend caps), the review module on (TypeSafe and DashScope keys), Qwen web search and
  DeepSeek search on beside SearXNG, the web-read DeepSeek-Fetch fallback on, the learning loop on (every lane run is `automated`, so it
  teaches nothing), all request-size, rate and concurrency limits per runtime and per project, idle and proxy timeouts.
- Skill roots: `OPEN_SCIENCE_RUNTIME_SKILL_DIRS` is production's value (core, curated-scientific, office, community, geo-private,
  capability-skills). `geo-private` is empty in a public checkout, here and in the image.
- The provider keys are held by the control plane's gateways only. The runtime container holds none: `lane.py` checks, on the first
  runtime that runs in a job, that no key value is in the container's definition or in any process environment inside it and that no
  secrets directory is mounted (`runtimeKeyless` in every bundle's `lane.json`).
- The driver: `bench-driver.mjs` (bench-driver/3) from the source ref, one throwaway account and one driver process per request, runs
  marked `automated`.

## Different, and why

| What | Production | Lab | Why / effect on a measurement |
|---|---|---|---|
| Host | Tencent, Beijing, shared with the serving stack | GitHub-hosted Azure runner (westus), 4 vCPU, 16 GB, kernel 7.0.0-1017-azure, Docker 28.0.4, Compose 2.38.2, fresh per job | no cloud credential exists; latency to DeepSeek and to every site differs (US egress), and a search engine that refuses a Chinese datacentre address may answer here and the other way round |
| Knowledge-base intake (OpenList) | OpenList + the parsing API, `OPEN_SCIENCE_SOURCE_INGESTION_ENABLED=true` | **absent**: `OPEN_SCIENCE_SOURCE_INGESTION_ENABLED=false`, no OpenList | the benchmarks upload into the workspace (`/api/files/upload`, root workspace), which parses nothing in production either; the parser itself is on (above), so a PDF a page serves is read as in production |
| Specialist engines | meta, MR (R), bibliometric, research-topic, peer-review, drug-safety all up; `REQUIRE_ALL_SPECIALIST_ADAPTERS=true` | not run; `REQUIRE_ALL_SPECIALIST_ADAPTERS=false`. The drug-evidence adapter and the result-replay engine are run | a request the router sends to one of those six capabilities reports it blocked. The open-domain line, which every benchmark of this round uses, does not need them |
| Modules | 虚拟临床研究, 循证 GEO, frontier, evolution, IM on | all off | not part of any benchmark; they would only spend |
| Web reading | direct, plus the AgentBay cloud browser for pages drawn in script (`WEB_RENDER_ENABLED=true`), Tokyo edge for a few hosts | direct from the runner; **no cloud browser** (`WEB_RENDER_ENABLED=false`), **no edge proxy** | a page that needs rendering is unreadable by our own reader and falls to the DeepSeek-Fetch fallback; a host production reaches through Tokyo is reached directly here. Why neither can be matched is in the next section |
| Web search | SearXNG as production's engines allow, Qwen web search, DeepSeek search, and the Tokyo node's SearXNG merged in | the bundled SearXNG from US egress (`WEB_SEARCH_URL` = the compose service), Qwen web search, DeepSeek search | the engine list and what each returns depend on the address they are asked from; the dated rows of DeepSeek search lead each merge, as in production. The Tokyo node's results are the part the lab cannot have |
| **Benchmark datasets** (deliberate) | reachable | **`huggingface.co`, `www.huggingface.co`, `hf.co`, `www.hf.co`, `cdn-lfs.huggingface.co`, `cdn-lfs-us-1.huggingface.co`, `cdn-uploads.huggingface.co`, `datasets-server.huggingface.co`, `cdn-lfs.hf.co`, `cas-bridge.xethub.hf.co`, `transfer.xethub.hf.co` and `hf-mirror.com` resolve to 127.0.0.1 inside the web and SearXNG containers** (`extra_hosts` in `docker-compose.lab.yml`) | in baseline v1, 11 of 80 MedBrowseComp runs searched for or opened the benchmark's own dataset on Hugging Face and one read a row holding its gold answer. The web-read gateway refuses a host that resolves to a private address (`web_read_host_forbidden`) and never sends such a URL to a second reader. Runtime containers have no route out at all. The runner host itself (the lane's own input-file fetch) still reaches them. A web search can still *list* such a page; reading it is refused. Any other host that serves a benchmark (GitHub mirrors, papers with code) is not blocked: see the next row |
| **Contamination record** (deliberate) | none | every result bundle's `lane.json` carries `contamination`: each URL in the run's tool calls and results whose text contains one of `medbrowsecomp`, `medcalc-bench`, `autoresearchbench`, `deep_research_bench`, `deepresearch-bench`, `bixbench`, `researchclawbench`, `bioxarena` (case-insensitive), with where it was found (call or result), the tool and the name, plus a count of URLs on a dataset host | record only; nothing in a run is changed by it. A scorer or the lead decides what a hit means |
| Release receipt | a signed DeepSeek receipt minted every 12 h by the receipt service | `{}`: `/api/ready` reports `modelGateway: deepseek_release_receipt_invalid` and the web container reads as unhealthy | nothing but readiness reads the receipt (the gateway serves regardless); minting one starts a runtime and spends tokens for a certificate no benchmark needs |
| Public URL | `https://<host>` behind Caddy | `http://127.0.0.1:8787`, no Caddy | the driver's Origin must equal the request origin the server computes from this scheme (`assertSameSiteBrowserRequest`; an https public URL refuses every registration with `403 csrf_required`). Cookies are not `Secure` |
| `/api/ready` | 200 | **503** with exactly three checks red: `modelGateway` (`deepseek_release_receipt_invalid`), `publicUrl` (`public_url_https_required`), `runtime` (`runtime_ui_origins_invalid`); every other check ok, including backup, memory (off), documentParser, release and resources | the three are consequences of the rows above. Nothing a run does reads readiness; the web container's own health check reads it, so Compose shows the web container as unhealthy |
| Monitoring, alerting, object backup | Prometheus, Alertmanager, Grafana, blackbox, node exporter; encrypted local backup daily + off-box copies | none of the monitoring stack; the local encrypted backup scheduler runs (daily, one-day retention) because readiness asks for its receipt | no operator watches a lab job |
| ToolUniverse sidecar, managed browser container | on (`tooluniverse` profile, `MANAGED_BROWSER_ENABLED=true`) | not run (`MANAGED_BROWSER_ENABLED=false`; no `OPEN_SCIENCE_TOOLUNIVERSE_MCP_URL`) | the root session has no ToolUniverse tool set and no managed browser; the other research tools are the same |
| Pharmacy reference database, drug-label index | the licensed data | a synthetic one-row fixture (as CI does), no label index | `pharmacy_reference` answers from the fixture; label search falls back to the public connectors |
| Concurrency | `MAX_RUNNING_RUNTIMES=4`, `MAX_CONCURRENT_TASKS=2`, per user 2, per project 1 | per job: `MAX_RUNNING_RUNTIMES` = workers + 1, `MAX_CONCURRENT_TASKS` = workers + 1, per user 2, per project 1 | one runtime per worker and one spare; each request has its own account and its own project, so no request waits for another's runtime |
| Accounts | the operator's, plus real users | none: each request registers a throwaway account (`bench-<time>-<hex>`) and deletes it with its runtimes and projects | nothing persists between requests |
| Signing material | long-lived | generated fresh in every job (gateway, workload, backup, metrics, database) | nothing of one job outlives it |
| Keys | the operator's files | the same files for DeepSeek, DashScope, EviMed, TypeSafe and Materials Project, from the one Actions secret `RSI_LAB_BUNDLE` (deleted at the end of the round); the Unpaywall contact address is passed to the public-source gateway as in production; two operator addresses (the parser service, the Tokyo edge's host, used only for a reachability counter) travel in the same bundle and never enter the repository; no edge credential is in it | a lab run spends the production DeepSeek key's balance; the key is held by the web container's gateway only |
| Time | the instance lives for weeks | a job is at most 350 minutes; a cold stack: the first run of every project starts a runtime from nothing | an item that needs a warm cache sees none |

## What remains different, why it cannot be matched, and what is known of its effect (2026-11-02)

| Difference | Why it cannot be matched | What is known of the effect |
|---|---|---|
| The runner is a GitHub-hosted Azure machine in the US (westus), production is a Tencent host in Beijing | No Beijing machine is available to the lab and no cloud credential exists in it; the lab is the Actions runner and nothing else. Latency to DeepSeek and to every site differs, and a search engine or a publisher that refuses one datacentre answers the other | Round 1's AutoResearchBench deep (40 rows, three repeats, both arms): the tool failure rate was 6% in the lab and 7% in production's own baseline (figures from the round-1 comparison, not recomputed here). The two are the same within the noise of that sample; nothing in the lab's results has needed a correction for it |
| No AgentBay cloud browser (`WEB_RENDER_ENABLED=false`) | Rendering a page drawn in script needs the owner's Alibaba AgentBay account and its credential; a credential for it in an Actions secret of a public repository is a standing risk this lab does not take, and the runner has no browser the control plane's reader is written for | A page that is drawn in script and has no static text is unreadable by our own reader and goes to the DeepSeek-Fetch fallback (labelled `via: "deepseek-fetch"`, a rendition with no byte snapshot) in the lab and, when the browser also fails, in production. Counted in the contamination and transcript records, not measured against production |
| Beijing's direct egress, and the Tokyo edge for the hosts production routes through it | The edge proxy accepts connections on 443 only from production's address (its firewall); a runner is refused. Checked from the development machine on 2026-11-02 (TCP 443 times out while 22 answers) and, from a runner, by `stack.py verify` in every job (`stack.edge.tcp443`, no credential sent). The only other door is a root shell on the node, which a lab must not hold. The edge's credentials were therefore not used | Production routes `gtexportal.org`, `api.omim.org` and `api.materialsproject.org` through it by default and retries `web_read` through it on 403/429/451/503; the lab reaches those hosts directly and gets whatever a US datacentre gets. The node's own SearXNG (pubmed, semantic scholar, crossref, arxiv, a rate-limited Google cse) is merged into production's search and absent here; the bundled SearXNG asks the same engines from the runner's address |
| OpenList (knowledge-base intake) is not run | Intake is a project feature no benchmark uses; running it adds a service and a credential for nothing a run reads | None expected: a benchmark file goes to the workspace |
| Modules (虚拟临床研究, 循证 GEO, frontier, evolution, IM) and the six specialist engines are off | Not part of any benchmark; they would only spend | A request the router sends to a specialist engine reports it blocked; the open-domain line every benchmark of the rounds uses does not need them |
| A cold stack per job and a throwaway account per request | By design (nothing of one job outlives it) | An item that needs a warm cache sees none; production's runtimes are warm after the first run of a project |

## Measured on the runner (2026-11-02, batch b031: one job, the base images, two synthetic requests)

- The stack with the context engine came up in 81 s (`compose up` 50 s, the web API answering at 52 s); readiness was 503 with the same three checks red as before
  (`modelGateway`, `publicUrl`, `runtime`); `memory` and `memoryIndex` were ok, and the engine answered `/health` on the first try. The engine's peak memory was 824 MiB, the
  whole stack's 1,986 MiB with two runtimes (334 and 320 MiB): the engine does not change how many lanes a runner holds.
- A MedCalc-style item (a creatinine clearance, no benchmark row) and a web-search item (a search, two page reads, three tool calls, results returned) ran to `succeeded` in
  49 and 47 s, ¥0.034 and ¥0.073. The counters after both: memory turn commits 0, learning records 0, learning refusals 2, turns the commit path declined as platform-started 2:
  an automated run on a throwaway account is neither remembered nor learnt from. The runtime held no provider key.
- The Tokyo edge: `tcp443: timeout` from the runner.
- A derived web image (`webPatch`, batch b033): `stack.py build-web-delta` laid the control plane's sources and the domain package of a ref over the base web image in 4 s,
  the stack came up on it in 87 s and a request ran on it. A runtime delta still takes about 9 minutes (511 s in b032) with the 24 GB swap file the lane workflow adds for the build.
  Building it once and loading it in the arm's other jobs from an artifact was tried (archive 1,925 MiB zstd, transfer fine) and removed: `docker load` of the saved image failed on the
  runner with "max depth exceeded", so every job of a patched arm builds its own.

## Measured on the runner (2026-11-01)

- Kernel `7.0.0-1017-azure`, LSMs `lockdown,capability,landlock,yama,apparmor,ima,evm`; the Landlock ABI the image's Python reads is **8**.
  `deploy/runtime-dsh/check-tool-sandbox.sh` on the runtime image passes every check (the environment, the sandbox runner, /dev/shm, the OOM
  guard, job_kill, the analysis libraries). The runtime runs with `OPEN_SCIENCE_RUNTIME_SANDBOX_ENFORCEMENT` at the production default, `full`.
- A job from start to a lane ready to claim: about 4.5 minutes (artifact 21 s, verify and load 135 to 160 s, stack up 46 to 49 s, optional
  sandbox check 27 s). A delta runtime image adds 9 to 11 minutes and needs swap (below).
- Peak memory, three concurrent items on one runner (4 vCPU, 16 GB): each runtime 350 to 500 MiB (cgroup `memory.peak`), the whole stack
  1.7 GB. The memory limit of 3 GB per runtime was never approached; CPU (4 vCPU for three 2-CPU runtimes) is what sets the lane count.

## Not verified in the lab

- That a web search from a US runner returns what a search from Beijing returns. It does not, and nothing here tries to make it (the part of production's search that comes from the Tokyo node cannot be reproduced, see above).
- BioXArena inputs: the items name files that `bioxarena_prepare.py` carves from the raw public tasks; a lane fetches public files only, so a
  BioXArena request needs that step added (or the prepared inputs placed on the broker host).

- Rate limits (added during round 1): auth 100000 per 5 minutes (production 20), command 12000/min (120), general 60000/min (600). A lane registers one throwaway account per request from one address; at 20 per 5 minutes, `429 auth_rate_limited` left no result, an infrastructure failure, never a score.
