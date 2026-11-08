# Capsule proving instruments

`inputs.mjs`, `sources.json` and `pools/` preserve official corpus identities and separate runtime input from scoring answers. Public product transport, tool-world tasks and frozen confirmation remain separate pending work.

## Offline semantic judging

The owner replaced the offline Claude role with Alibaba Cloud Model Studio **`qwen3.8-max`** on 2026-11-05. Model ID and compatible API are documented in the [official model reference](https://help.aliyun.com/en/model-studio/qwen3-8-max). This judge runs only on saved development-engine replay artifacts; it does not run extraction or alter mechanical results.

```sh
node evals/capsule-proving/offlineJudge.mjs \
  --input /private/candidate-write-quality-repeat3.json \
  --output /private/candidate-qwen-judgements.json \
  --key-file /private/dashscope.api-key
```

The key is read from the operator's file and never saved in the result. The fixed official Beijing endpoint receives six semantic samples per call, original case evidence, expected outcomes and the files actually retained. Results record requested/returned model, request IDs, usage, raw replies, source/packet/prompt hashes and a full denominator. The API returns a model alias; the recorded call date and identity are not an immutable model-weights digest.

Rerun the same command to resume. Different source, packets, prompt or rubric refuse that checkpoint. Missing extraction or seed prerequisites stay `unknown`; the deterministic eligibility check is reapplied to old checkpoint rows with any earlier judgement retained as audit evidence. Machine failures remain machine failures regardless of semantic judgement. Explicit infrastructure retries must be identified separately; never replace quality failures with reruns.

```sh
node --test evals/capsule-proving/tests/*.test.mjs
```
