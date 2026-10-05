import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";

/** A stand-in for the runtime controller's disposable container that really runs the candidate.
 * A double that returns a canned output cannot tell code that computes from code that recites, which is
 * the one thing the behavioural tests are about; this one executes the candidate's Python with the
 * system interpreter, files under a temporary `/candidate`, input on stdin, last 64 KiB of stdout back.
 * @param {{calls?:any[]}} [record] */
export function pythonExecVerify(record = {}) {
  return async body => {
    record.calls?.push(body);
    const root = await mkdtemp(path.join(os.tmpdir(), "exec-verify-"));
    try {
      for (const [name, text] of Object.entries(body.files ?? {})) { await mkdir(path.dirname(path.join(root, name)), { recursive: true }); await writeFile(path.join(root, name), text); }
      const code = `import json,sys\nsys.path.insert(0,${JSON.stringify(root)})\n${body.code.replaceAll("/candidate", root)}`;
      return await new Promise(resolve => {
        const child = spawn("python3", ["-c", code], { cwd: root, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } });
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.resume();
        child.on("error", () => resolve({ ok: false, joined: false, executionStarted: false, output: "" }));
        child.on("close", status => resolve({ ok: status === 0, joined: true, executionStarted: true, output: output.slice(-65536) }));
        child.stdin.on("error", () => {});
        child.stdin.end(JSON.stringify(body.input ?? null));
      });
    } finally { await rm(root, { recursive: true, force: true }); }
  };
}
