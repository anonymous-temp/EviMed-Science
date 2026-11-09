import urllib.request, pathlib, json, concurrent.futures, os, sys
base='https://packagemanager.posit.co/cran/2026-09-28/src/contrib/'
dest=pathlib.Path(os.environ.get('VCR_EVAL_CRAN_DIR','.evimed-local/acceptance/vcr-professional-full-20261105/cran/src/contrib')); dest.mkdir(parents=True,exist_ok=True)
if '--prepare-only' in sys.argv: print(dest.resolve()); raise SystemExit(0)
lock=json.load(open('项目代码/vcr-engine/R/package-lock.json'))
def get(pair):
 name=pair['package']+'_'+pair['version']+'.tar.gz'; p=dest/name
 if not p.exists():
  with urllib.request.urlopen(base+name,timeout=90) as r:p.write_bytes(r.read())
 return name
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
 for r in pool.map(get,lock['packages']): print(r,flush=True)
for name in ['PACKAGES','PACKAGES.gz']:
 with urllib.request.urlopen(base+name,timeout=90) as r:(dest/name).write_bytes(r.read())
