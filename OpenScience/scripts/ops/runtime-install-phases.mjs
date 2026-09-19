/**
 * The runtime image's build as a Dockerfile runs it (rt, 2026-09-20).
 *
 * The runtime's install steps are phases of deploy/runtime-dsh/install-runtime.sh,
 * each called from its own `RUN bash /usr/local/lib/evimed/install-runtime.sh
 * <phase>`, and both runtime Dockerfiles (Docker and AgentBay) run them. A check
 * of what a build does — the compliance audit, the deployment tests — reads
 * each phase's body in the place the Dockerfile runs it, and a phase the script
 * defines but no `RUN` calls is not read at all. Concatenating the two files
 * would let "the build runs its boot proof" pass on a function nobody calls,
 * which is the mention-is-not-an-invocation defect the audit has met twice.
 *
 * Pure and dependency-free: the compliance audit ships in the web image, where
 * `deploy/runtime-dsh` does not, and the tests import this without running it.
 *
 * @module runtime-install-phases
 */

const RUN_PHASE = /^RUN bash \/usr\/local\/lib\/evimed\/install-runtime\.sh ([a-z-]+)\s*$/;

/**
 * Each phase the script dispatches, with the body of the function it runs.
 * @param {string} script the text of install-runtime.sh
 * @returns {Map<string, string>}
 */
export function definedInstallPhases(script) {
  /** @type {Map<string, string>} */
  const functions = new Map();
  const lines = String(script).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const head = /^([a-z_]+)\(\) \{$/.exec(lines[index]);
    if (!head) continue;
    const body = [];
    /** @type {string | null} */
    let heredoc = null;
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (heredoc) {
        body.push(line);
        if (line === heredoc) heredoc = null;
        continue;
      }
      // A function ends at a column-0 brace; one inside a heredoc (the Python
      // the smokes run has several) is part of the body.
      if (line === "}") break;
      body.push(line);
      heredoc = /<<-?'?([A-Za-z_]+)'?\s*$/.exec(line)?.[1] ?? null;
    }
    functions.set(head[1], body.join("\n"));
  }
  /** @type {Map<string, string>} */
  const phases = new Map();
  for (const [, phase, name] of String(script).matchAll(/^ {2}([a-z-]+)\) ([a-z_]+) ;;$/gm)) {
    const body = functions.get(name);
    if (body === undefined) throw new Error(`install-runtime.sh dispatches ${phase} to ${name}, which it does not define`);
    phases.set(phase, body);
  }
  return phases;
}

/**
 * The phases a Dockerfile runs, in order.
 * @param {string} dockerfile
 * @returns {string[]}
 */
export function installPhaseCalls(dockerfile) {
  return String(dockerfile).split("\n").map((line) => RUN_PHASE.exec(line)?.[1]).filter((phase) => phase !== undefined);
}

/**
 * The Dockerfile with every install-phase `RUN` replaced by the phase's body.
 * A `RUN` naming a phase the script lacks is a build that cannot succeed, and
 * says so.
 * @param {string} dockerfile @param {string} script
 * @returns {string}
 */
export function expandInstallPhases(dockerfile, script) {
  const phases = definedInstallPhases(script);
  return String(dockerfile).split("\n").map((line) => {
    const call = RUN_PHASE.exec(line);
    if (!call) return line;
    const body = phases.get(call[1]);
    if (body === undefined) throw new Error(`the runtime Dockerfile runs install phase ${call[1]}, which install-runtime.sh does not define`);
    return `RUN ${body.trim()}`;
  }).join("\n");
}
