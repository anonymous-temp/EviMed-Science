#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const excludedNames = new Set([
  ".git",
  ".openscience-web-data",
  ".venv",
  "dist",
  "evals",
  "node_modules",
  "scientific-agent-skills-main",
  "target",
]);
const excludedFiles = new Set([".env", "deploy.env", "release-manifest.json"]);
const textExtensions = new Set([
  ".c", ".cc", ".conf", ".cpp", ".cs", ".env.example", ".go", ".h", ".hpp",
  ".java", ".js", ".json", ".jsx", ".kt", ".kts", ".md", ".mjs", ".properties",
  ".py", ".rb", ".rs", ".sh", ".toml", ".ts", ".tsx", ".xml", ".yaml", ".yml",
]);

function isTextFile(file) {
  if (file.endsWith(".env.example")) return true;
  return textExtensions.has(path.extname(file).toLowerCase());
}

function placeholder(value) {
  const normalized = value.toLowerCase();
  return !value
    || value.includes("${")
    || value.startsWith("$")
    || /^(?:null|true|false|none|disabled|empty|0)$/.test(normalized)
    || /(example|fake|placeholder|redacted|replace|test-only|your[-_ ]key)/.test(normalized);
}

// A subject label carrying a real hospital number. Two of these reached the
// repository as illustrations — in a skill file copied into every runtime
// container, and in a test fixture — because they were written in comments and
// prose, which the credential rules below deliberately skip. Examples must use
// the reserved synthetic range (a leading 9), so a real number stands out.
const SUBJECT_LABEL = /\bP\d{6,}\b/g;
const SYNTHETIC_SUBJECT = /^P9\d{5,}$/;

export function suspiciousLines(content, file = "fixture.yml") {
  const findings = [];
  const structuredConfig = /(?:\.ya?ml|\.properties|\.env\.example)$/i.test(file);
  for (const [index, rawLine] of content.split("\n").entries()) {
    const line = rawLine.trim();
    // Checked before the comment skip: this is exactly what hid in a comment.
    for (const label of line.match(SUBJECT_LABEL) ?? []) {
      if (!SYNTHETIC_SUBJECT.test(label)) { findings.push(index + 1); break; }
    }
    if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith("*")) continue;

    const prefixedCredential = line.match(/\b(?:(?:sk|tvly)-[A-Za-z0-9_-]{20,}|(?:LTAI|AKIA)[A-Za-z0-9]{12,})\b/)?.[0];
    if (prefixedCredential && !placeholder(prefixedCredential)) {
      findings.push(index + 1);
      continue;
    }
    const credentialUrl = line.match(/(?:mongodb|mysql|postgres(?:ql)?|redis|https?):\/\/[^\s:/]+:([^\s@/]+)@/i);
    if (credentialUrl && !placeholder(credentialUrl[1])) {
      findings.push(index + 1);
      continue;
    }

    if (structuredConfig) {
      const scalar = line.match(/^(?:[A-Za-z0-9_.-]*?(?:password|passwd|secret|api[-_]?key|token|access[-_]?key(?:[-_](?:id|secret))?))\s*[:=]\s*["']?([^"'#]+)["']?/i);
      if (scalar && !placeholder(scalar[1].trim())) findings.push(index + 1);
    }
  }
  return findings;
}

async function collect(directory, output) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (excludedNames.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(target, output);
      continue;
    }
    if (!entry.isFile() || excludedFiles.has(entry.name) || !isTextFile(target)) continue;
    const content = await readFile(target, "utf8");
    if (content.includes("\0")) continue;
    const lines = suspiciousLines(content, target);
    if (lines.length) output.push({ file: target, lines });
  }
}

export async function auditSourceSecrets(roots = [
  repoRoot,
  path.resolve(repoRoot, "../项目代码"),
  path.resolve(repoRoot, "../接口文档"),
]) {
  const findings = [];
  for (const root of roots) await collect(root, findings);
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = await auditSourceSecrets();
  if (findings.length) {
    console.error("Source credential audit failed. Remove literals and rotate any exposed credentials:");
    for (const finding of findings) {
      console.error(`- ${path.relative(path.resolve(repoRoot, ".."), finding.file)} (lines ${finding.lines.join(", ")})`);
    }
    process.exitCode = 1;
  } else {
    console.log("Source credential audit passed: no hard-coded credentials detected.");
  }
}
