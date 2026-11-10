// Which memory directories a consolidation pass asks the engine about (v0.5.3 refuses the memories root: an upstream defect at the tag).
import assert from "node:assert/strict";
import test from "node:test";

import { consolidationDirectories } from "../src/nativeMemoryConsolidation.mjs";

const root = "viking://user/u-0123456789abcdef01234567/memories";
const file = (path) => ({ uri: `${root}/${path}` });

test("the directories are the memory types that hold at least two files the platform reads, sorted", () => {
  const files = [
    file("profile.md"),
    file("preferences/self/a.md"), file("preferences/self/b.md"), file("preferences/corrections/c.md"),
    file("entities/person/p.md"), file("entities/person/q.md"),
    file("decisions/one.md"),
    file("observations/note.md"), file("observations/other.md"),
    file("evimed/user/preference/rec1.md"), file("evimed/user/preference/rec2.md"),
    file("preferences/.overview.md"),
  ];
  assert.deepEqual(consolidationDirectories(files, root), ["entities", "preferences"]);
});

test("a root with nothing in a type directory has no directory to ask for, and a file outside the root is nobody's", () => {
  assert.deepEqual(consolidationDirectories([file("profile.md"), file("entities/a.md")], root), []);
  assert.deepEqual(consolidationDirectories([{ uri: "viking://user/other/memories/entities/a.md" }, { uri: "viking://user/other/memories/entities/b.md" }], root), []);
});
