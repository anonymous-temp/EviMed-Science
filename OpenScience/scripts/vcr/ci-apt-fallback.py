"""Copy APT sources, changing only the exact GitHub Ubuntu Azure mirror."""
import pathlib
import re
import shutil
import sys

source, destination = map(pathlib.Path, sys.argv[1:])
# Copy only source declarations, never arbitrary APT state or symlink targets.
if source.is_symlink() or (source / 'sources.list.d').is_symlink():
    sys.exit(1)
destination.mkdir(parents=True, exist_ok=True)
(destination / 'sources.list.d').mkdir(exist_ok=True)
for original in [source / 'sources.list', *(source / 'sources.list.d').glob('*')]:
    if original.is_symlink():
        sys.exit(1)
    if original.is_file() and (original.name == 'sources.list' or original.suffix in ('.list', '.sources')):
        shutil.copyfile(original, destination / original.relative_to(source))
changed = False
for path in [destination / 'sources.list', *(destination / 'sources.list.d').glob('*')]:
    if not path.is_file() or path.suffix not in ('', '.list', '.sources'):
        continue
    text = path.read_text()
    original_text = text
    # Require token boundaries: lookalike hosts, credentials and alternate paths
    # are never rewritten. Preserve suites, components and Signed-By verbatim.
    def mirror_copy(match):
        global changed
        name = match.group(1)
        original = source / name
        if original.is_symlink() or not original.is_file():
            raise ValueError('Untrusted mirror list')
        content = original.read_text()
        rewritten = re.sub(r'(?<!\S)https?://azure\.archive\.ubuntu\.com/ubuntu/?(?=\s|$)',
                           'https://archive.ubuntu.com/ubuntu/', content)
        target = destination / name
        target.write_text(rewritten)
        changed = changed or content != rewritten
        return 'mirror+file:' + str(target)

    # Only the two known runner-owned mirror lists are admitted. No traversal,
    # percent decoding, alternate roots or symlinks may escape the source copy.
    text = re.sub(r'(?<!\S)mirror\+file:/etc/apt/(apt-mirrors(?:-security)?\.txt)(?=\s|$)', mirror_copy, text)
    updated = re.sub(r'(?<!\S)https?://azure\.archive\.ubuntu\.com/ubuntu/?(?=\s|$)',
                     'https://archive.ubuntu.com/ubuntu/', text)
    if original_text != updated:
        path.write_text(updated)
        changed = True
if not changed:
    sys.exit(1)
