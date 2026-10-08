# Autopilot verification reply

The second process a scheduled task's adopted finding goes through is an independent verifier: a fresh session that is given one claim and
its sources and writes `verification.json` (`verdict`, `numbersReproduced`, `recomputed`, `checkedSources`, …) for the control plane to read.
Its **reply** is separate from that file, and it is read by a person. On 2026-10-08 the owner's screenshots showed the reply printing
`weakened`, `refuted`, `verification.json`, `numbersReproduced` and `recomputed` — the file's own names, in a sentence meant for a
researcher (design reference §8.6, E-10; the same class as `replies-carry-no-back-office`).

The fix is in the instruction (`verificationPrompt` in `apps/server/src/autopilotService.mjs`): it now says the reply is for the researcher,
asks for plain sentences in the language of the claim, and names the file's vocabulary as what not to say. The vocabulary is one list
(`VERIFICATION_FILE_VOCABULARY`); the instruction and `check_reply.mjs` both read it, so a field added to the file cannot leak unnamed.

## What is here

- `cases.json` — three written situations (an effect to recompute, numbers without an effect, a claim without numbers). The sources are
  synthetic: placeholder DOIs and invented text, so no case states anything about a real trial.
- `check_reply.mjs` — `backstageWordsIn(reply)`: a closed-vocabulary check (the file's name and field names anywhere; the verdict words only
  when used as a label). Unit-tested by `apps/server/test/autopilotVerificationPrompt.test.mjs`.
- `run_eval.mjs` — the live run: the prompt that ships, a small tool loop standing in for the runtime, the check above, and
  `parseVerificationResult` on the file written. Writes `results/run-<stamp>-<arm>.json`.
- `../writing-incidents/cases/2026-10-08-autopilot-verification-reply-names-the-file.json` — the incident itself.

## Running it

```
node evals/autopilot-verification-reply/run_eval.mjs --runs 3 --key-file <deepseek key file> --without-reply-instruction   # control
node evals/autopilot-verification-reply/run_eval.mjs --runs 3 --key-file <deepseek key file>                               # shipped
```

Acceptance for E-10 is the live version of this on a **new** conversation (an old conversation's history makes the model imitate its old
format): the same claim, re-run, and the reply names none of the words. The control arm matters: a reply that is clean without the
instruction shows a case too easy to judge the instruction by.

Which model capability would make this deletable: a verifier whose reply the control plane builds from its file, after which there is no
model-written reply to keep clean.
