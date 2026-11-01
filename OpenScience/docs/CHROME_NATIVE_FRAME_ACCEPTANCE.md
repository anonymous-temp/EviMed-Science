# Chrome native-frame acceptance

## Resolved investigation: 2026-11-01

The earlier GEO handoff recorded a Chrome first-open timeout. Controlled comparison isolated it to the browser-control debugger attachment used during acceptance, rather than the normal Chrome product path. This is an acceptance-instrumentation correction, not a new product retry mechanism.

The comparison kept the same Chrome 156 profile, account, local control plane, runtime and primary session:

| Condition | Observation |
| --- | --- |
| Browser-control debugger attached, first frame navigation | The server returned HTTP 200 with HTML headers. Chrome retained zero document bytes, reported the request as blocked for about 60 seconds, and finally recorded `net::ERR_ABORTED` when the existing shell deadline removed the frame. No native script boot was observed. |
| Native Chrome tab, controlled through macOS accessibility without claiming it through the browser debugger | First open completed in about 2 seconds. Refresh also completed in about 2 seconds. |
| Attach browser control to that same successful tab, then refresh | The native document stalled again. |
| Cancel the debugger attachment in Chrome's own information bar | The already-pending document immediately continued to the native composer. No page reload or Retry action was used. |
| Continue using native Chrome controls | Workbench-to-conversation return retained the primary session; a newly created project opened its native composer in about 5 seconds without retry. |

This A/B/A comparison establishes the attachment-dependent failure boundary. It does not identify an uninspected internal debugger implementation or claim that an upstream browser-control package has been patched. The recovery is to remove the interfering attachment and use the unaffected native-control lane for startup acceptance. The earlier in-app browser control independently passed first open and refresh.

## Required acceptance procedure

1. Use an owned local fixture with the real pinned kernel and production-shaped authentication. Keep credentials out of logs and reports.
2. Open a fresh Chrome tab through native browser controls. Do not claim that tab with a debugger-based browser connector during the first-open/refresh lane.
3. Verify new-project first open, existing-session first open, refresh, workbench return and browser history. Require the actual native composer and disappearance of the opening cover; HTTP 200 alone is not a pass.
4. Record the primary session before and after navigation. Navigation and draft insertion must not submit work.
5. If an instrumented tab stalls, preserve a sanitized network summary. Compare the same tab without its debugger attachment before changing the product. An attachment-dependent failure must not be reported as a product cold-start defect.
6. For detailed DOM inspection, attach only after a successful startup. Keep that inspection's evidence separate from clean startup acceptance. Do not silently retry a failed acceptance case and count the retry as a first-open pass.

Do not disable site isolation, frame sandboxing, CSP, authentication or membership checks. Do not increase the product timeout or auto-reload a potentially active conversation to conceal instrumentation interference.

The ignored local proof directory is `outputs/audit/geo-chrome-first-open-20261101/` at the repository root. It retains a minimized network summary and the successful native Chrome screenshot. Raw HAR files can contain session material and must not be committed or published. This local comparison does not constitute a production deployment or a claim about every Chrome extension combination.
