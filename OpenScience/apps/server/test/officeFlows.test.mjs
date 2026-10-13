// The Office skills' flows on real files: change one clause and leave the rest alone, add a column and a totals row
// with real formulas, split a slide and switch the palette in the same file, pull a table out of a PDF.
//
// The Python suite lives beside the skills (runtime/skills/office/shared/test_office_flows.py) because the image build
// runs it too, with the LibreOffice Kit the kernel ships; here it runs against the libraries CI pins. The kit's own
// cases skip where the kit is absent. Where python-docx and its siblings are absent the suite cannot run at all: that
// is a skip on a developer's machine and a failure in CI, where the workflow installs them.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const python = process.env.EVIMED_OFFICE_PYTHON ?? "python3";
const suite = path.join(repoRoot, "runtime/skills/office/shared/test_office_flows.py");

const libraries = spawnSync(python, ["-c", "import docx, pptx, xlsxwriter, openpyxl, pdfplumber, PIL"], { encoding: "utf8" });

test("the Office flows pass on real documents", { skip: libraries.status !== 0 && !process.env.CI ? `the pinned Office libraries are not installed for ${python}` : false }, () => {
  assert.equal(libraries.status, 0, `the pinned Office libraries must be installed in CI: ${libraries.stderr}`);
  const result = spawnSync(python, [suite], { encoding: "utf8", timeout: 280_000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`.slice(-4000));
  assert.match(result.stderr, /\bOK\b/);
});
