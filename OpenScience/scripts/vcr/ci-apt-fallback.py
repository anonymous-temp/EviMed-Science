"""Copy APT sources, changing only the exact GitHub Ubuntu Azure mirror."""
import pathlib
import re
import shutil
import sys

source, destination = map(pathlib.Path, sys.argv[1:])
shutil.copytree(source, destination, dirs_exist_ok=True)
changed = False
for path in [destination / 'sources.list', *(destination / 'sources.list.d').glob('*')]:
    if not path.is_file() or path.suffix not in ('', '.list', '.sources'):
        continue
    text = path.read_text()
    # Require token boundaries: lookalike hosts, credentials and alternate paths
    # are never rewritten. Preserve suites, components and Signed-By verbatim.
    updated = re.sub(r'(?<!\S)https?://azure\.archive\.ubuntu\.com/ubuntu/?(?=\s|$)',
                     'https://archive.ubuntu.com/ubuntu/', text)
    if text != updated:
        path.write_text(updated)
        changed = True
if not changed:
    sys.exit(1)
