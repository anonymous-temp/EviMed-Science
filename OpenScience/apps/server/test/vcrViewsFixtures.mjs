// Where the page fixtures live. A module of its own so a test that only needs
// to read them does not import (and so run) the seeded-study test.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "vcr-views");
