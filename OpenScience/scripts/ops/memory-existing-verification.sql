-- Run with psql -X -v ON_ERROR_STOP=1 -f on the serving database, using an existing read-only login.
-- Old revisions age out; absent positive evidence cannot establish that verification never ran.
BEGIN TRANSACTION READ ONLY;
SELECT count(*) FILTER (WHERE reason IN ('verification_corrected','verification_unsupported')) AS existing_verify_revisions,
       max(changed_at) FILTER (WHERE reason IN ('verification_corrected','verification_unsupported')) AS latest_existing_write,
       count(*) FILTER (WHERE reason IN ('consolidation_unverified','consolidation_corrected')) AS merge_review_revisions
FROM evimed_memory.native_revisions
WHERE actor='platform';
SELECT count(*) FILTER (WHERE consolidated_at IS NOT NULL) AS accounts_with_completed_merge,
       max(consolidated_at) AS latest_merge FROM evimed_memory.native_accounts;
COMMIT;
