The interrupted third-battery run on `evimed-20260910-a8f9c0f`: run_f325fbb118189d309cb0afc77d12b46a, dispatched 2026-09-10T02:09:37Z.
The root delegated correctly (the fix under test) and the first deliverable was accepted on its second submission, but six
false `appraisal_domain_missing` advisories — the validator read only `study.domains` while the skill never said the ratings
live there — sent the root to delegate the same deliverable a second and a third time. The runtime was stopped during v3;
the run ended `specialist_receipt_digest_mismatch` and its 24 files were saved unverified. Its run.json was overwritten by
the accepted run that followed in the same results directory; the ledger and transcript are archived on the data volume
under `.openscience/ledger-archive/2026-09-10/cdss-access/acceptance-evidence-appraisal-run2/`.
