#!/usr/bin/env python3
"""Copy the engine and evaluation drivers once and record every source byte."""
import hashlib, json, os, pathlib, shutil, subprocess, sys
root = pathlib.Path(__file__).resolve().parents[3]
dest = pathlib.Path(sys.argv[1]).resolve()
if dest.exists():
    raise SystemExit('Destination exists; refusing to overwrite a frozen snapshot')
inputs = [pathlib.Path('项目代码/vcr-engine'), pathlib.Path('OpenScience/evals/vcr-professional-plugins')]
files = []
for rel in inputs:
    for path in sorted((root/rel).rglob('*')):
        if path.is_symlink():
            raise SystemExit(f'Symlink needs explicit review: {path.relative_to(root)}')
        if path.is_file() and '__pycache__' not in path.parts and '.git' not in path.parts:
            files.append(path.relative_to(root))
pre = {str(p): hashlib.sha256((root/p).read_bytes()).hexdigest() for p in files}
for p in files:
    target = dest/p; target.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(root/p,target)
after_files = sorted(path.relative_to(root) for rel in inputs for path in (root/rel).rglob('*') if path.is_file() and not path.is_symlink() and '__pycache__' not in path.parts and '.git' not in path.parts)
if sorted(files) != after_files:
    raise SystemExit('Source inventory changed while freezing; abandon this snapshot')
post = {str(p): hashlib.sha256((root/p).read_bytes()).hexdigest() for p in files}
copied = {str(p): hashlib.sha256((dest/p).read_bytes()).hexdigest() for p in files}
if pre != post or pre != copied:
    raise SystemExit('Source changed while freezing; abandon this snapshot and retry under a new name')
meta = {'gitHead': subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(),
        'engineStatus': subprocess.check_output(['git','status','--short','--','项目代码/vcr-engine'],cwd=root,text=True).strip(),
        'filesSha256': copied}
(dest/'source-manifest.json').write_text(json.dumps(meta,indent=2,ensure_ascii=False)+'\n')
for path in sorted(dest.rglob('*'),reverse=True):
    os.chmod(path, 0o555 if path.is_dir() else 0o444)
os.chmod(dest,0o555)
print(hashlib.sha256((dest/'source-manifest.json').read_bytes()).hexdigest())
