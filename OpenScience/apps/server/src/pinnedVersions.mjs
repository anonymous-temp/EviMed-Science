// The control plane's one reader of `deps-version.json`, the single definition of every version tracked upstream.
//
// A pin written as a literal in the module that needs it (the installed `dsh-cite` was one, in five modules and two
// Dockerfiles) is a pin nobody finds on the day it moves; the failure was a runtime probe refusing the bundle in
// production, not a failed build. Modules that need a pinned version import it from here, and
// `test/pinsWrittenOnce.test.mjs` fails on a literal that comes back.
//
// Read rather than imported as a JSON module: the control plane already reads files, and an import attribute is a
// parse error on the linter this repo pins. The domain package uses the import form because it must not touch
// `node:fs`. The web image copies `deps-version.json` beside the server, so the read cannot be absent where this runs.
import fs from "node:fs";

/** @type {Readonly<Record<string, any>>} */
export const PINNED = Object.freeze(JSON.parse(fs.readFileSync(new URL("../../../deps-version.json", import.meta.url), "utf8")));

/** The `dsh-cite` bundle every runtime image installs and every probe approves. */
export const CITE_VERSION = String(PINNED.dsh?.citeVersion ?? "");
if (!/^\d+\.\d+\.\d+/.test(CITE_VERSION)) throw new Error("deps-version.json carries no dsh.citeVersion");
