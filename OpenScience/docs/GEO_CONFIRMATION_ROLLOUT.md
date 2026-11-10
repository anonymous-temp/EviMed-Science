# GEO confirmation authorization rollout

This change is not safe for a mixed-version GEO measurement fleet. An older
worker does not enforce the confirmation receipt or the three-attempt recovery
limit and can submit jobs that the new worker would stop. **Do not start the new
measurement worker until every older GEO measurement worker has been stopped
and its termination has been verified.** A rolling overlap is a release blocker.

Preserve the database and task references through the cutover. The new worker
stops legacy confirmation jobs without an authorization receipt when they have
not been accepted upstream, and stops an unreferenced expired confirmation lease
at its third attempt as delivery unknown. Jobs with an upstream `external_ref`
remain eligible for polling and result processing. Confirmation rounds accepted
under the new receipt remain eligible to finish after authorization is withdrawn;
withdrawal prevents future rounds, not completion of already accepted work.

Before production release, verify the worker inventory and versions on every
host, confirm the old fleet is stopped, deploy the matching server and worker,
then verify both the running version and the queue outcomes. This document is a
rollout gate, not evidence that deployment or production validation occurred.

## Database fence

The first start of a worker of this version installs a trigger on `evimed_geo.probe_jobs`: a lease (queued to leased) of a job in a
confirmation round is refused with `geo_confirmation_worker_outdated` unless the leasing statement also wrote the attempt it took into
`lease_fence`, which only this version does. An older worker that is still running therefore cannot submit a confirmation ask once the
new version has started; it fails loudly on its next lease instead of overlapping silently. This does not replace the rollout gate above:
the fence covers the lease, not an older worker's other statements, and a lease taken before the trigger existed is handled by the
legacy rules. Confirm the old fleet is stopped before the new version starts.
