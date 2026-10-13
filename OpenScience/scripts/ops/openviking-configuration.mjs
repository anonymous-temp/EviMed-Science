import {
  OPENVIKING_MEMORY_TEMPLATES_DIR, OPENVIKING_MEMORY_TYPES, OPENVIKING_SHIM_PORT, openVikingKnowledgeModelKey,
} from "../../apps/server/src/openVikingLayout.mjs";

/**
 * Where the engine reaches the control plane's model gateway: the web service's name and port on
 * `memory-recall-internal` (deploy/web/docker-compose.yml), and the gateway's `/internal/model/v1` prefix. A constant
 * and not a setting, for the reason at the foot of `expectedOpenVikingConfiguration`.
 */
export const OPENVIKING_MODEL_GATEWAY_URL = "http://open-science-web:8787/internal/model/v1";

/**
 * The engine's whole configuration, rendered rather than hand-written.
 *
 * Every value here was settled against a running server — v0.4.19 for the first block, v0.5.0 for the rest
 * (the two lab records of 2026-10-12, `packages/contracts/openviking/README.md`) — and each one is a default that is
 * wrong for this deployment:
 *
 *   storage.workspace   defaults to `./data` = /app/data, outside the volume
 *   server.auth_mode    unset with a root key silently selects `api_key` mode
 *   embedding.dense     unset installs a local embedder the image cannot load
 *   provider            `openai` never sends `dimensions`, so a model whose
 *                       native vector is shorter than the index fails at write
 *
 * THE MODEL PATH. `vlm` is the control plane's own model gateway with a service bearer, not a provider: the DeepSeek
 * key stays where it is, and every call the engine makes is reserved, settled and counted like any other. The model
 * name is a placeholder the gateway replaces with the one the deployment certifies.
 *
 *   vlm.extra_request_body   thinking off. Left out, the gateway turns it off for this caller anyway; left on, a short
 *                            extraction costs four times as much and takes five times as long, and a write-back's
 *                            summaries cost nine times the compile that caused them (both labs).
 *   vlm.max_tokens           16384 for extraction and summaries: with thinking off the largest extraction answer seen
 *                            was 1.1K tokens, and the gateway reserves money for whatever is named.
 *   bot.agents               the Compile agent's own section, for two reasons. Its output cap is 32768: at 8192, 20 of
 *                            278 compile rounds were cut mid tool call and 30% of the output was wasted. And its bearer
 *                            is the second one derived from the service key, which is the only way a call can say it is
 *                            a compile round: nothing in an engine request names a purpose, a user or a task.
 *
 * MEMORY. Extraction is on and writes with this deployment's templates. The allowlist of eight types has to be in
 * `server.user_config_defaults`: without it a new user gets every registered type, upstream's `events` included,
 * which copies quoted messages into memory files. `auto_commit_policy` has to exist before the first session does —
 * a session created without one is never scanned. `link_enabled` and session skill extraction stay off (nothing
 * here reads their output). `prefetch_search_topn` 10: every multi-file type shares those slots.
 *
 * COMPILE. `compile_api.base_url` is the identity shim on the container's loopback; with it set the server no longer
 * calls the bot directly, the bot itself is still started by `OPENVIKING_WITH_BOT=1`. Command execution in a compile
 * is off (the five official skills run without it), the bot's ten-minute heartbeat is off, and query expansion is off
 * (`retrieval.enable_intent`): it is one model call per recall that the control plane's own reranker already replaces.
 *
 * LANGUAGE. `output_language_override` is deliberately absent. It was `zh` while the engine extracted nothing; set, it
 * forces every memory and summary into that language whatever the user wrote (measured on v0.5.0: English, Japanese
 * and mixed text all resolved to `zh`). Unset, the engine detects per content (`zh-CN`, `en`, `ja`) and tells the model
 * to write in it, which is not enough on its own: with the templates' Chinese examples and section labels in front of
 * it the model wrote an English conversation's memories in Chinese in 2 of 3 live runs (2026-10-13). Each template
 * therefore opens with a language block (`deploy/web/openviking/memory-templates-src/_language.txt`, filled with the
 * detected language); after it, 0 of 8 English conversations gave Chinese memory text (one card kept a Chinese section
 * label) and a Chinese conversation was unchanged. Compile's language is the bot's own judgement and is steered per
 * task by the instruction the knowledge module sends.
 *
 * There is no `rerank` section on purpose: `/search/find`, the only search our layout uses, never reranks. The
 * reranker runs in the control plane, over text it has already hydrated from PostgreSQL.
 *
 * An unknown key no longer aborts startup (it warns, since v0.4.22), so a key renamed upstream would fall back to its
 * default without a word. This file therefore cannot be the proof that the configuration took effect; the control
 * plane's startup check is (`apps/server/src/openVikingEngine.mjs`).
 *
 * Nothing here is read from the ambient environment. `--check` compares this rendering with the stored file byte for
 * byte, so a value taken from the shell would make the verdict depend on which shell ran it: an operator who
 * generated the file in one environment and checked it in another would be told their credentials had drifted, about
 * a file that was correct.
 *
 * @param {{ rootApiKey: string, embeddingApiKey: string, modelKey: string, pin: any, modelGatewayUrl?: string }} input
 *   `modelGatewayUrl` exists for a lab instance that reaches a control plane on the host; production never passes it.
 */
export function expectedOpenVikingConfiguration({ rootApiKey, embeddingApiKey, modelKey, pin, modelGatewayUrl = OPENVIKING_MODEL_GATEWAY_URL }) {
  const dimension = pin.embedding.dimension;
  // The gateway replaces the name with the model the deployment certifies; this is what a log line of the engine shows.
  const model = "deepseek-flash";
  return {
    // The fallback for a request that names no account. This client names one
    // on every request — trusted mode requires the header — so these two are
    // never what decides where a memory is stored, and
    // `OPEN_SCIENCE_OPENVIKING_ACCOUNT` moves the client without touching this
    // file.
    default_account: "evimed",
    default_user: "evimed",
    embedding: {
      dense: {
        provider: "dashscope",
        // The text path; the provider's own default is the multimodal endpoint,
        // which a text embedding model does not answer.
        input: "text",
        // The host only: this provider appends `/compatible-mode/v1` itself.
        api_base: pin.embedding.apiBase,
        api_key: embeddingApiKey,
        model: pin.embedding.model,
        dimension,
      },
    },
    storage: {
      workspace: "/app/.openviking/data",
      agfs: { backend: "local" },
      vectordb: { backend: "local", dimension },
    },
    vlm: {
      provider: "openai",
      api_base: modelGatewayUrl,
      api_key: modelKey,
      model,
      max_tokens: 16_384,
      timeout: 120,
      extra_request_body: { thinking: { type: "disabled" } },
    },
    memory: {
      extraction_enabled: true,
      extraction_output_format: "python",
      custom_templates_dir: OPENVIKING_MEMORY_TEMPLATES_DIR,
      prefetch_search_topn: 10,
      session_skill_extraction_enabled: false,
      link_enabled: false,
      session_auto_commit: { enabled: true, check_interval_seconds: 300, scan_rate_limit_files_per_second: 50 },
    },
    server: {
      host: "0.0.0.0",
      port: 1933,
      cors_origins: [],
      auth_mode: "trusted",
      root_api_key: rootApiKey,
      user_config_defaults: {
        memory_policy: { memory_types: [...OPENVIKING_MEMORY_TYPES] },
        auto_commit_policy: { idle_timeout_seconds: 900, pending_token_threshold: 150_000, message_count_threshold: 100 },
      },
    },
    compile_api: { base_url: `http://127.0.0.1:${OPENVIKING_SHIM_PORT}`, poll_interval_ms: 5_000 },
    bot: {
      agents: {
        provider: "openai",
        api_base: modelGatewayUrl,
        api_key: openVikingKnowledgeModelKey(modelKey),
        model,
        max_tokens: 32_768,
        thinking: false,
      },
      heartbeat: { enabled: false },
      sandbox: { backends: { direct: { allow_compile_exec: false } } },
    },
    retrieval: { enable_intent: false },
    // The embedder is a public HTTPS endpoint, and the model gateway above is
    // not what this switch guards (it does not apply to `vlm.api_base`; lab,
    // 2026-10-12): nothing else on this host's private ranges is a legitimate
    // target for this server.
    allow_private_networks: false,
  };
}
