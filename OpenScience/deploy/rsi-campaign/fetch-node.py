"""Install a Node.js release tarball verified against the release's SHASUMS256.txt (image build step, no other tool needed)."""
import hashlib
import lzma
import sys
import tarfile
import urllib.request

mirror, version, target = sys.argv[1].rstrip('/'), sys.argv[2], sys.argv[3]
name = f'node-v{version}-linux-x64.tar.xz'
sums = urllib.request.urlopen(f'{mirror}/v{version}/SHASUMS256.txt', timeout=60).read().decode()
expected = next(line.split()[0] for line in sums.splitlines() if line.endswith(f'  {name}'))
data = urllib.request.urlopen(f'{mirror}/v{version}/{name}', timeout=600).read()
if hashlib.sha256(data).hexdigest() != expected:
    raise SystemExit(f'{name}: checksum mismatch')
with tarfile.open(fileobj=lzma.LZMAFile(__import__('io').BytesIO(data))) as archive:
    prefix = f'node-v{version}-linux-x64/'
    for member in archive.getmembers():
        if not member.name.startswith(prefix) or '..' in member.name.split('/'):
            continue
        member.name = member.name[len(prefix):]
        if member.name:
            archive.extract(member, target, filter='tar')
print(f'node {version} installed in {target}')
