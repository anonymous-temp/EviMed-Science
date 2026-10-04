/**
 * A stand-in for the runtime controller's intake container that runs the very
 * script the container runs, as a local process.
 *
 * It builds the real launch plan (`vcrIntakePlan`), takes the script and flags
 * from it, and runs `python3` on the repository's copy of that script with
 * `/input` and `/output` mapped to the attempt's directories. So the contract
 * between the plan and the script — the flags, the file names, the result files —
 * is exercised without Docker; what Docker adds (no network, a read-only root,
 * ceilings) is asserted over the plan itself in `vcrIntakeController.test.mjs`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "../../src/security.mjs";
import { vcrIntakePlan } from "../../src/vcrIntakeController.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The research MCP server's sources, where the image keeps both scripts. */
export const MCP_DIR = path.resolve(HERE, "../../../../runtime/mcp/evimed-research");

/** Whether the local `python3` imports every named module. @param {string[]} modules */
export function pythonCan(...modules) {
  const probe = spawnSync("python3", ["-c", modules.map(name => `import ${name}`).join(";")], { encoding: "utf8" });
  return probe.status === 0;
}

/**
 * @param {any} config
 * @param {{ calls?: any[] }} [options]
 */
export function localIntakeController(config, { calls = [] } = {}) {
  return {
    calls,
    /** @param {'extract'|'digitize'} kind @param {{ attemptId: string, inputDigest: string }} reference */
    async runVcrIntake(kind, reference) {
      const plan = vcrIntakePlan(config, kind, reference);
      const entry = plan.args.indexOf("--entrypoint");
      const [, interpreter, , script, ...flags] = plan.args.slice(entry);
      if (interpreter !== "python3") throw new Error("the plan changed its interpreter");
      const mapped = flags.map(flag => (flag === "/input/request.json" ? path.join(plan.dir, "input", "request.json")
        : flag === "/input" ? path.join(plan.dir, "input") : flag === "/output" ? path.join(plan.dir, "output") : flag));
      calls.push({ kind, reference, files: await fs.readdir(path.join(plan.dir, "input")) });
      const done = spawnSync("python3", [path.join(MCP_DIR, path.basename(script)), ...mapped], {
        encoding: "utf8", timeout: 120_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      });
      if (done.status !== 0) throw new HttpError(502, "vcr_intake_failed", "The conversion did not finish.");
      return { finished: true };
    },
  };
}

/**
 * Real PDF and Word files for the tests, built by the extractor's own test
 * helpers (no PDF writer is needed: they are assembled byte by byte).
 * @param {string} directory
 * @returns {Promise<Record<string, string>>} name → path
 */
export async function writeRecordFixtures(directory) {
  const program = `
import sys, pathlib
sys.path.insert(0, ${JSON.stringify(path.join(MCP_DIR, "test"))})
sys.path.insert(0, ${JSON.stringify(MCP_DIR)})
import test_vcr_record_extract as t
out = pathlib.Path(sys.argv[1])
page = [
    "Patient 0001 admitted with chest pain radiating to the left arm.",
    "Past history: hypertension for ten years, type 2 diabetes mellitus.",
    "BP 140/90 mmHg, heart rate 88 bpm, SpO2 97 percent on room air.",
    "Troponin I 0.04 ng/mL on arrival, repeat at three hours 0.06 ng/mL.",
    "ECG: ST depression in leads V4 to V6. Started on aspirin and heparin.",
]
(out / "text.pdf").write_bytes(t.pdf_bytes([page, page]))
(out / "scan.pdf").write_bytes(t.pdf_bytes([[], [], []]))
(out / "mixed.pdf").write_bytes(t.pdf_bytes([page, [], page, page]))
body = t.para("患者男，62岁，主诉胸痛2小时。") + "<w:tbl>" + t.row(t.cell(t.para("检查项目")), t.cell(t.para("结果"))) + t.row(t.cell(t.para("肌钙蛋白I")), t.cell(t.para("0.04 ng/mL"))) + "</w:tbl>" + t.para("诊断：不稳定型心绞痛，建议住院观察。")
(out / "record.docx").write_bytes(t.docx_bytes(body, app_pages=2))
(out / "image-only.docx").write_bytes(t.docx_bytes('<w:p><w:r><w:drawing><a:blip xmlns:a="x"/></w:drawing></w:r></w:p>'))
(out / "not-a.pdf").write_bytes(b"plain text pretending to be a pdf")
`;
  const done = spawnSync("python3", ["-c", program, directory], { encoding: "utf8" });
  if (done.status !== 0) throw new Error(`fixture build failed: ${done.stderr}`);
  const names = ["text.pdf", "scan.pdf", "mixed.pdf", "record.docx", "image-only.docx", "not-a.pdf"];
  return Object.fromEntries(names.map(name => [name, path.join(directory, name)]));
}
