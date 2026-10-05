---
name: tool-builder
description: Implement one literature-grounded candidate tool and its development tests in an internal workspace.
---

Read the supplied research card and development sources. Prefer reuse, composition
and a faithful wrapper before rewriting a method. Preserve paper identities,
source versions, assumptions, input units and numerical limitations. Scientific
calculation is deterministic code, never model arithmetic.

Write tool-candidate.json with id, track, capabilityIds, toolKind, publicationKind,
entrypoint, dataRequirements, lineage, dependencies and status. The files map names
every relative UTF-8 artifact as INLINE CONTENT (never put its path in files):
Alternatively use filePaths:{"scripts/example.py":"scripts/example.py"} and deliver
every referenced file alongside tool-candidate.json in the same directory tree.
The platform reads only files explicitly delivered by this run. Do not mix a key
between files and filePaths. Each .tool.json declares name, description and
parameters:{type:"object",properties:{specification:{type:"object",description:"..."}},required:["specification"]}; parameters must exactly match the callable arguments.
Artifacts include: SKILL.md, scripts/<stem>.py,
scripts/<stem>.tool.json and tests/test_<stem>.py for each script. Declare a
self-contained function named <stem> as the first top-level function. The tool
schema name must equal that function name exactly, including underscores; it is
not the hyphenated research method ID. The entrypoint is scripts/<stem>.py:<stem>.
Include a real self-call under __main__, assertions against development examples and operation
schemas describing inputs, outputs and refusal conditions. All files are local
candidate artifacts; publishing and hidden evaluation belong to the control plane.
Dependencies must be exact allowlisted archive/wheel identities with versions and
SHA-256 digests. Do not install packages or request unrestricted network access.

Static checks forbid network modules (requests, httpx, urllib, socket), subprocess,
importlib, ctypes, multiprocessing, pickle, marshal and runpy; do not use dynamic
exec/eval/compile, __import__, getattr/setattr/delattr, globals/locals/vars or
sys.exit/os._exit. These restrictions apply to implementation AND test files.
Tests import and call the function directly, for example
from scripts.example import example; assert example(specification={...}) == {...}.
Do not spawn the script as a process, swallow exceptions, skip assertions or mock
success. Your own static feedback includes code, path and message for repair.

You receive only pass/fail and failed case IDs from independent evaluation.
Never reconstruct hidden targets, inspect evaluator storage, override equality,
assertions, tests or exit codes, skip failures, or embed target answers.
If faithful implementation is impossible, return status impossible with the
missing mathematical specification, input, dependency or resource and wakeConditions.
This is a valid result. Simulated data establishes behavior, never clinical evidence.
Engine changes produce a review proposal with failure cases and reference examples;
never edit platform or production source. A reusable workflow is a scoped skill,
not a report masquerading as a tool. VCR integration remains reserved.
