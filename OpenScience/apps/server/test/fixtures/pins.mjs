// The tracked upstream versions a server test may need, read from the one definition (`deps-version.json`) instead of
// restated. A literal copy of a pin in a test is what `test/pinsWrittenOnce.test.mjs` fails on.
import { readFileSync } from "node:fs";

export const PINS = Object.freeze(JSON.parse(readFileSync(new URL("../../../../deps-version.json", import.meta.url), "utf8")));

/** The `dsh-cite` bundle the runtime image installs and the probe approves. */
export const CITE_VERSION = String(PINS.dsh.citeVersion);
