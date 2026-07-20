# Hosted Web Security Incident Response

Date: 2026-07-13

Scope: security and privacy incidents affecting the controlled hosted Web
deployment, its identity provider, Runtime Controller, project containers,
application data volume, backups, monitoring, or model-provider traffic.

This procedure is mandatory operational policy, not permission to inspect user
research. Organizational legal, privacy, employment, and notification rules
still apply.

## Roles and Severity

Assign named people before deployment:

- Incident Commander: owns severity, containment, recovery, and timeline.
- Security Operator: controls identity, network, hosts, containers, and secrets.
- Data Access Approver: authorizes any access to a user's project or account
  records; this must not be the person performing the access.
- Privacy/Legal Owner: decides notification, preservation, and disclosure duties.
- Service Owner: validates the application and scientific workflow after
  recovery.

Treat suspected cross-user access, Runtime Controller compromise, Docker socket
exposure, model-key exposure, unapproved project-data access, or confirmed data
exfiltration as critical. Treat repeated authentication abuse, quota bypass,
backup integrity failure, or persistent malware in one project as high until
scope is proven.

## Incident Record

Open a restricted incident record before accessing application data. Record:

- incident ID, start time, reporter, commander, severity, and current status;
- affected release ID, source revision, image IDs, host, user IDs, project IDs,
  and normalized route names;
- alert names, readiness codes, request IDs, task IDs, runtime container names,
  and relevant timestamps;
- every containment action, secret/session revocation, data-access approval,
  evidence digest, recovery check, decision, and owner;
- whether personal, confidential, regulated, unpublished, or third-party data
  may be involved, without copying that data into the incident record.

Do not paste cookies, tokens, passwords, model keys, prompts, file contents,
workspace paths, raw request bodies, or unredacted identity-provider claims into
chat, tickets, dashboards, or general-purpose incident channels.

## Triage and Containment

1. Confirm the alert using `/api/health`, `/api/ready`, protected metrics, the
   expected release manifest, and sanitized request IDs. Do not dismiss a
   readiness failure by disabling its check.
2. Stop new traffic or the affected feature first. For suspected tenant escape
   or Docker control compromise, remove the entire host from traffic and stop
   new Runtime Controller operations.
3. Revoke affected Open Science sessions. For identity compromise, also disable
   the identity-provider account or group assignment; application logout alone
   does not revoke the provider session.
4. Stop affected project runtimes through the supported API or trusted
   controller path. If the controller may be compromised, isolate the host and
   use the reviewed Docker operator path; never give the Web API direct Docker
   socket access as a recovery shortcut.
5. Disable runtime network egress when model-provider or external-tool traffic
   is in scope. Preserve gateway/network logs before changing allowlists.
6. Rotate exposed OIDC, metrics, alerting, backup, registry, object-store, and
   model-provider credentials from a clean operator environment. Recreate
   services so old material is no longer mounted, then revoke old credentials.
7. Preserve sanitized logs and immutable release metadata before restarting,
   deleting containers, restoring data, or pruning logs.

Containment must not mount the application data volume read-write into an ad
hoc troubleshooting container, disable symlink/path validation, enable host
shell escape hatches, or copy the complete data volume to an analyst laptop.

## User Project Access Authorization

Monitoring, an error report, or operator status alone does not authorize reading
research files. Access to a user's project workspace, provenance content,
account export, security log, or cross-user metadata requires:

1. A documented incident ID and a specific question that cannot be answered by
   sanitized metrics, normalized logs, or release metadata.
2. Approval from the Data Access Approver and, when applicable, the
   Privacy/Legal Owner. Emergency access must be reviewed by a second person as
   soon as containment permits.
3. The narrowest user, project, files, time range, and read-only mechanism. Do
   not browse adjacent projects or run agent/model processing on evidence.
4. A record of operator identity, approval, start/end time, exact scope,
   commands/tools used, files accessed, and evidence digests. Record file names
   only in the restricted evidence record when names themselves are sensitive.
5. Removal of temporary access and verified deletion of working copies after
   the preservation period. Evidence storage must be encrypted, access logged,
   and owned outside the affected application host.

Use project/account export APIs only when the authenticated data subject is
performing the export. Operator evidence collection must not impersonate a user
or create an undocumented session.

## Evidence Preservation

- Preserve the release manifest, Compose configuration digest, image IDs,
  container metadata, readiness response, alert state, and relevant host/network
  event timestamps.
- Preserve bounded sanitized API error, security, audit, task, and runtime log
  tails before their `.1` rotation is overwritten. Treat all logs as sensitive.
- Hash every exported evidence file with SHA-256, record the source, collector,
  timestamp, and transfer, and store it in approved encrypted evidence storage.
- Capture volatile container/process/network metadata before restart when safe;
  do not capture environment variables or command payloads that may contain
  credentials or research content.
- Never alter the original backup or evidence archive. Restore only into a
  disposable isolated location and record the restore-drill result.

## Recovery Gate

The Incident Commander may restore traffic only after all applicable checks
pass:

1. The vulnerable credential, release, configuration, user, project, runtime,
   or host is contained and the scope is documented.
2. `pnpm preflight:host --env-file deploy/web/.env --online` passes on the
   target host, followed by `pnpm smoke:deployment` through the public route.
3. `/api/ready` reports release, security, identity, backup, observability,
   Runtime Controller, runtime sandbox, and kernel policy checks as healthy.
4. The immutable release manifest matches the deployed Web, Runtime, and Caddy
   image IDs; the API still has no Docker socket and the controller is not
   exposed.
5. Authentication, session revocation, project isolation, runtime start/stop,
   alert delivery, encrypted backup, and a disposable restore drill are tested.
6. Temporary operator access is removed, rotated secrets are confirmed, and
   enhanced monitoring plus a rollback owner are active.
7. The Privacy/Legal Owner has recorded the notification decision and any
   preservation or regulatory deadlines.

Do not restore traffic with a waived readiness check, an untracked image, a
stale backup state, an uncontained runtime, or an unresolved cross-user scope.

## Notification and Review

- Notify affected users and authorities according to the recorded legal/privacy
  decision; state known facts, affected period and data categories, containment,
  user actions, and a contact route. Do not speculate or disclose another
  tenant's identity.
- Within the organization's required period, publish a restricted post-incident
  review covering root cause, detection gap, control effectiveness, timeline,
  recovery evidence, owners, and due dates.
- Convert corrective actions into tracked engineering or operational work.
  Re-run the hosted compliance audit, Linux Docker CI, host preflight, deployment
  smoke, backup restore drill, and relevant isolation tests before closure.
