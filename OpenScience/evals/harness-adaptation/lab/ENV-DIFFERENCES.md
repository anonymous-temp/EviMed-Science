# The RSI lab compared with production

What a benchmark item meets in a lane (a GitHub Actions job running the CI release images) and how that differs from production, as read on
2026-11-01. The levers are the lab's `stack.py` (`PARITY`, `lab_overrides`) against production's non-secret levers
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
| Memory (OpenViking) | native memory for every account | **absent**: `OPEN_SCIENCE_OPENVIKING_URL` empty, `OPEN_SCIENCE_MEMORY_ENABLED=false` | no context engine; memory is off as a status, nothing is recalled or kept. A run is `automated`, which is handed no resident profile in production either, so the main effect is on the knowledge-base wiki and graph, which no benchmark uses |
| Knowledge-base intake | OpenList + the in-house parsing API | **absent**: `OPEN_SCIENCE_SOURCE_INGESTION_ENABLED=false`, `OPEN_SCIENCE_REQUIRE_DOCUMENT_PARSER=false` | the benchmarks upload into the workspace (`/api/files/upload`, root workspace), which parses nothing in production either; a PDF or image the item carries is read by the runtime's own tools |
| Specialist engines | meta, MR (R), bibliometric, research-topic, peer-review, drug-safety all up; `REQUIRE_ALL_SPECIALIST_ADAPTERS=true` | not run; `REQUIRE_ALL_SPECIALIST_ADAPTERS=false`. The drug-evidence adapter and the result-replay engine are run | a request the router sends to one of those six capabilities reports it blocked. The open-domain line, which every benchmark of this round uses, does not need them |
| Modules | 虚拟临床研究, 循证 GEO, frontier, evolution, IM on | all off | not part of any benchmark; they would only spend |
| Web reading | direct, plus the AgentBay cloud browser for pages drawn in script (`WEB_RENDER_ENABLED=true`), Tokyo edge for a few hosts | direct from the runner; **no cloud browser** (`WEB_RENDER_ENABLED=false`), **no edge proxy** | a page that needs rendering is unreadable by our own reader and falls to the DeepSeek-Fetch fallback; a host production reaches through Tokyo is reached directly here |
| Web search | SearXNG as production's engines allow, Qwen web search, DeepSeek search | the bundled SearXNG from US egress (`WEB_SEARCH_URL` = the compose service), Qwen web search, DeepSeek search | the engine list and what each returns depend on the address they are asked from; the dated rows of DeepSeek search lead each merge, as in production |
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
| Keys | the operator's files | the same files for DeepSeek, DashScope, EviMed, TypeSafe and Materials Project, from the one Actions secret `RSI_LAB_BUNDLE` (deleted at the end of the round); the Unpaywall contact address is passed to the public-source gateway as in production | a lab run spends the production DeepSeek key's balance; the key is held by the web container's gateway only |
| Time | the instance lives for weeks | a job is at most 350 minutes; a cold stack: the first run of every project starts a runtime from nothing | an item that needs a warm cache sees none |

## Measured on the runner (2026-11-01)

- Kernel `7.0.0-1017-azure`, LSMs `lockdown,capability,landlock,yama,apparmor,ima,evm`; the Landlock ABI the image's Python reads is **8**.
  `deploy/runtime-dsh/check-tool-sandbox.sh` on the runtime image passes every check (the environment, the sandbox runner, /dev/shm, the OOM
  guard, job_kill, the analysis libraries). The runtime runs with `OPEN_SCIENCE_RUNTIME_SANDBOX_ENFORCEMENT` at the production default, `full`.
- A job from start to a lane ready to claim: about 4.5 minutes (artifact 21 s, verify and load 135 to 160 s, stack up 46 to 49 s, optional
  sandbox check 27 s). A delta runtime image adds 9 to 11 minutes and needs swap (below).
- Peak memory, three concurrent items on one runner (4 vCPU, 16 GB): each runtime 350 to 500 MiB (cgroup `memory.peak`), the whole stack
  1.7 GB. The memory limit of 3 GB per runtime was never approached; CPU (4 vCPU for three 2-CPU runtimes) is what sets the lane count.

## Not verified in the lab

- That a web search from a US runner returns what a search from Beijing returns. It does not, and nothing here tries to make it.
- BioXArena inputs: the items name files that `bioxarena_prepare.py` carves from the raw public tasks; a lane fetches public files only, so a
  BioXArena request needs that step added (or the prepared inputs placed on the broker host).

- Rate limits (added during round 1): auth 100000 per 5 minutes (production 20), command 12000/min (120), general 60000/min (600). A lane registers one throwaway account per request from one address; at 20 per 5 minutes, `429 auth_rate_limited` left no result, an infrastructure failure, never a score.
