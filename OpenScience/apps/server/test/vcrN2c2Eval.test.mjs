// The n2c2 2018 Track 1 matching evaluation's own tests (evals/vcr-matching/n2c2/n2c2.test.mjs) run with the server's, the way the
// criteria-parse check's are: fabricated notes only, no model call, no network. The tests that read the local, gitignored n2c2 data
// (and the official scorer) skip themselves when it is not unpacked, so this passes in CI without it.
import "../../../evals/vcr-matching/n2c2/n2c2.test.mjs";
