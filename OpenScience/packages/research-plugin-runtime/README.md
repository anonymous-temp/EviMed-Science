# Research plugin runtime

Shared DSH tool registration and asynchronous adapters for the four research bundles. Standalone mode is supported only in an operator-owned trusted workspace; it is not a sandbox or a multi-tenant isolation boundary and does not resist arbitrary same-UID code racing filesystem operations. The standalone adapter runs the existing VCR R engine installed separately by the operator and stores each job, result, progress and report under the configured workspace. Install the engine's documented R dependencies and provide its absolute directory as `VCR_ENGINE_ROOT`, the workspace as `VCR_PLUGIN_WORKSPACE`, and `VCR_PLUGIN_MODE=standalone` in the DSH profile environment. Source bindings supplied locally are recorded as unverified; no online retrieval or independent source verification is implied.

Hosted mode is the default and requires an injected `evimedResearchAdapter` service. It must bind each call to authenticated project and study scope and reauthorize every operation; it cannot fall back to local execution. Each tool receives the request-local adapter from `forCall(call)`. A process worker survives the initiating process; another process may read or request cancellation. A stale heartbeat identifies an interrupted worker; it does not automatically resume the job.

These packages and their shared dependencies must be distributed together until published. A temporary DSH profile can use pnpm workspace overrides to resolve the dependencies to their local tgz files. The existing engine is separately installed: the package does not copy scientific algorithms or bundle the R library. A clean clinical validation, model applicability review, publication and hosted acceptance are separate activities.

## Build and install an offline bundle

From the repository root, with the workspace's pnpm and Node toolchain installed, run:

```sh
node OpenScience/packages/research-plugin-runtime/scripts/pack-release.mjs /path/to/a/new-release-directory
```

The directory must not exist. It receives the four bundles, optional suite, shared runtime, harness port, domain, design tokens, an installer and a SHA-256 manifest. The manifest also records the source engine package-lock digest; it does not include the R engine or claim that the recipient's R library matches it. Install the separately distributed engine and its pinned R library as documented by that engine.

Use the supplied installer with DSH installed and an operator-owned DSH home:

```sh
DSH_HOME=/path/to/dsh-home node /path/to/release/install.mjs my-research virtual-trial
DSH_HOME=/path/to/dsh-home node /path/to/release/install.mjs my-research virtual-research-suite
```

The first command creates a new headless profile and installs through `dsh plugin`; it refuses to modify an unrelated existing profile. The second adds another bundle only to a profile created from the identical release at the same path. Product options are `virtual-trial`, `virtual-cohort`, `virtual-patient`, `synthetic-control` and `virtual-research-suite`. The release directory must remain available for its local dependency overrides. Hash checks detect a mismatch against the supplied manifest, but the manifest itself needs an independently trusted distribution channel. This workflow does not publish packages.

For standalone operation set `VCR_PLUGIN_MODE=standalone`, `VCR_PLUGIN_WORKSPACE` and `VCR_ENGINE_ROOT` in the environment used to launch the profile. The workspace must already exist. Hosted operation uses the host-injected authenticated adapter; standalone source assertions remain unverified. See each bundle's `SKILL.md` and `examples/` for callable operations and scientific limits.
