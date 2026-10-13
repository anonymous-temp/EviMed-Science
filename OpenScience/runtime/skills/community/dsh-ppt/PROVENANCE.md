# dsh-ppt

Vendored from https://github.com/STARDUSTLC666/dsh-ppt at `9ab3c88e8ed8992b1771434f9f59b4f1ae767630` (MIT).
Subdirectory: `skills/dsh-ppt`. Reviewed 2026-10-13.

Do not edit in place — `pnpm vendor:community-skills` overwrites this directory
from the pinned commit. Change `runtime/skills/community/sources.json` instead.

One sentence or a document to an HTML deck plus an editable PPTX. Self-contained: the deck builder ships inside the skill directory and runs under the bash tool, so nothing outside the sandbox is needed. Covers the teaching-deck and report-readout requests that manuscript-support has no answer for. Re-pinned 2026-10-13 from 0db836e8 to 9ab3c88e (0.2.1, upstream issue #1): the older build wrote every local-header offset in the zip's central directory as 0, so the PPTX it produced could not be opened by python-pptx, Info-ZIP or any reader that follows the central directory (a real run's deck failed `unzip -t` with an overlapped-components error). The fix-only commit is taken rather than the current 0.9.0, whose later references name plugin-only tools and an npm install the sandbox cannot run.
