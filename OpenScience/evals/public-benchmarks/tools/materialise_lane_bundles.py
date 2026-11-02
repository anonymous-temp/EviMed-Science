#!/usr/bin/env python3
"""Turn lane bundles (`<rid>.tgz` + `<rid>.meta.json` of the broker's inbox) into the result folders export_harness_arms.py reads.

  materialise_lane_bundles.py --registration rsi/round1/arb-deep/registration.json --role development --domain arb-deep \\
      --bench-key arb-deep-rsi --arm baseline=s1 --arm aa=aa --arm cand-806cd2194801=c0 --out /tmp/rsi1-scratch/round1/arb-deep/development

  --form dev           a bundle is `<prefix>.<domain>.<row>.r<k>` (the rids of make_screen.py and the arm builders); --arm NAME=PREFIX[@N]; `@N` takes the arm's runs from repeat
                       N of that prefix (a run is the target's repeat 0 when N is 1: `aa=m2@1` is the second run of the arm m2 standing as a
                       development A/A beside `baseline=m2`, which is its first)
  --form confirmation  a bundle is `cf.<domain>.<row>.<tag>.r<k>`; --arm NAME=TAG (tag `base` or `cstar`); --confirmation-prefix cf2 names the round's own `cf2.<domain>.<row>.<tag>.r<k>`

NAME is the arm of the source: `baseline`, `aa` or `cand-<12 hex>` (the candidate's digest on its image, which export_harness_arms.py
computes from --bundles). Rows and repeats are the registration's for the role. Output, below --out:

  <NAME>/<bench-key>__<armtoken>__<row>[_r<k>]/   the folder export_harness_arms.py --arm NAME=<out>/<NAME> --bench-key <bench-key> finds
                                                   (its `run_key` / `result_folder` build the name); the regular files of the bundle
  materialised.json                                per arm and run: the bundle's sha256 and where it came from; what is missing, corrupt,
                                                   ambiguous or an infrastructure failure; the prefixes of this domain that were ignored

Only the bundles of the named arms and rows are opened; any other prefix in the inbox is counted and left alone. The originals are only
read: nothing is moved, deleted or rewritten, and a bundle that fails its recorded sha256, holds another item than the one requested, or
exists twice with different bytes is reported and NOT materialised (the exporter then sees a missing run and says so; nothing is
zero-filled here). A run folder already materialised from the same bytes is left as it is. Exit 0 when every expected run is
materialised, 3 when some are not (the report says which), 2 on a bad request.

Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import json
import pathlib
import re
import shutil
import sys
import tarfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import export_harness_arms as eha  # noqa: E402
import round_lib as rl  # noqa: E402

SCHEMA = 'rsi-materialised-bundles/1'
FORMS = ('dev', 'confirmation')


class MaterialiseError(Exception):
    pass


def rid_of(form, prefix, domain, row, repeat, confirmation_prefix='cf'):
    if form == 'dev':
        return rl.rid_of(prefix, domain, row, repeat)
    return f'{confirmation_prefix}.{domain}.{row}.{prefix}.r{repeat}'.replace('/', '_')


def candidates_of(rid, inboxes):
    """Every bundle of this rid in the inboxes: [(tgz, meta path)], the archived `done.<rid>` form included."""
    found = []
    for directory in inboxes:
        for stem in (rid, f'done.{rid}'):
            tgz = pathlib.Path(directory) / f'{stem}.tgz'
            if tgz.is_file():
                found.append((tgz, pathlib.Path(directory) / f'{stem}.meta.json'))
    return found


def infra_marker(rid, inboxes):
    return any((pathlib.Path(d) / f'{rid}.infra-failed.json').is_file() or (pathlib.Path(d) / f'done.{rid}.infra-failed.json').is_file() for d in inboxes)


def read_meta(path):
    meta = rl.read_json(path) if path.is_file() else None
    return meta if isinstance(meta, dict) else None


def ignored_prefixes(inboxes, domain, named):
    """{first token of a rid: count} of this domain's bundles whose prefix is not one of the named arms (they are never opened)."""
    counts = {}
    pattern = re.compile(r'^(?:done\.)?([^.]+)\.' + re.escape(domain) + r'\.')
    for directory in inboxes:
        directory = pathlib.Path(directory)
        if not directory.is_dir():
            continue
        for path in directory.glob('*.tgz'):
            match = pattern.match(path.name)
            if match and match.group(1) not in named:
                counts[match.group(1)] = counts.get(match.group(1), 0) + 1
    return dict(sorted(counts.items()))


def materialise_run(rid, domain, row, inboxes, destination):
    """('ok', sha256, source) | (state, reason). Writes `destination` only for an ok run."""
    found = candidates_of(rid, inboxes)
    if not found:
        return ('infra', 'the broker marked the request as an infrastructure failure') if infra_marker(rid, inboxes) else ('missing', 'no bundle')
    digests = {}
    for tgz, meta_path in found:
        digest = rl.sha256_file(tgz)
        meta = read_meta(meta_path)
        if meta and meta.get('sha256') and meta['sha256'] != digest:
            return ('corrupt', f'{tgz.name}: sha256 differs from its meta')
        digests.setdefault(digest, (tgz, meta is not None))
    if len(digests) > 1:
        return ('ambiguous', f'{len(found)} bundles of this rid with {len(digests)} different contents')
    (digest, (tgz, has_meta)), = digests.items()
    marker = destination / '.bundle.sha256'
    if marker.is_file() and marker.read_text(encoding='utf-8').strip() == digest and (destination / 'result.json').is_file():
        return ('ok', digest, str(tgz), has_meta)
    staging = destination.with_name(destination.name + '.partial')
    if staging.exists():
        shutil.rmtree(staging)
    try:
        written = rl.extract_members(tgz, rid, staging, lambda rel: True)
    except (OSError, EOFError, tarfile.TarError) as error:  # a bundle that cannot be read is corrupt, not missing
        shutil.rmtree(staging, ignore_errors=True)
        return ('corrupt', f'{tgz.name}: unreadable ({type(error).__name__})')
    result = rl.read_json(staging / 'result.json') if 'result.json' in written else None
    if not isinstance(result, dict):
        shutil.rmtree(staging, ignore_errors=True)
        return ('corrupt', f'{tgz.name}: no readable result.json')
    if result.get('key') != rl.expected_key(domain, row):
        shutil.rmtree(staging, ignore_errors=True)
        return ('corrupt', f'{tgz.name}: the bundle holds another item than the one requested')
    (staging / '.bundle.sha256').write_text(digest + '\n', encoding='utf-8')
    if destination.exists():
        shutil.rmtree(destination)
    staging.rename(destination)
    return ('ok', digest, str(tgz), has_meta)


def run(args):
    if args.form not in FORMS:
        raise MaterialiseError(f'--form is one of {", ".join(FORMS)}')
    if args.domain not in rl.DOMAINS:
        raise MaterialiseError(f'unknown domain {args.domain!r}')
    registration = rl.read_json(args.registration)
    if not isinstance(registration, dict) or not isinstance(registration.get('rows'), dict) or args.role not in registration['rows']:
        raise MaterialiseError(f'{args.registration} is not a round registration with rows.{args.role}')
    rows = [str(i) for i in registration['rows'][args.role]]
    repeats = args.repeats or int((registration.get('repeats') or {}).get(args.role) or 1)
    arms = []
    for spec in args.arm:
        if '=' not in spec:
            raise MaterialiseError(f'--arm {spec!r} is NAME=PREFIX')
        name, prefix = spec.split('=', 1)
        prefix, _, offset_text = prefix.partition('@')
        if offset_text and not offset_text.isdigit():
            raise MaterialiseError(f'--arm {spec!r}: @N is a repeat number')
        offset = int(offset_text) if offset_text else 0
        if name != eha.BASELINE and name != eha.CONTROL and not re.fullmatch(r'cand-[0-9a-f]{12}', name):
            raise MaterialiseError(f'arm name {name!r}: baseline, aa or cand-<12 hex>')
        if not prefix or any(name == a[0] or (prefix, offset) == (a[1], a[2]) for a in arms):
            raise MaterialiseError(f'--arm {spec!r}: names and prefixes must be non-empty and used once')
        arms.append((name, prefix, offset))
    if not any(name == eha.BASELINE for name, _, _ in arms):
        raise MaterialiseError('an export needs the baseline arm')
    inboxes = [pathlib.Path(p) for p in (args.inbox or rl.default_inboxes())]
    out = pathlib.Path(args.out)
    report = {'schema': SCHEMA, 'registration': {'family': registration.get('family'), 'digest': registration.get('digest')}, 'role': args.role,
              'domain': args.domain, 'form': args.form, 'benchKey': args.bench_key, 'repeats': repeats, 'rows': len(rows), 'inboxes': [str(p) for p in inboxes],
              'arms': {}, 'ignoredPrefixes': ignored_prefixes(inboxes, args.domain, {prefix for _, prefix, _ in arms} | ({args.confirmation_prefix} if args.form == 'confirmation' else set()))}
    problems = 0
    for name, prefix, offset in arms:
        entry = {'prefix': prefix + (f'@{offset}' if offset else ''), 'expected': len(rows) * repeats, 'materialised': 0, 'runs': [], 'notMaterialised': []}
        for row in rows:
            for repeat in range(repeats):
                rid = rid_of(args.form, prefix, args.domain, row, repeat + offset, args.confirmation_prefix)
                key = eha.run_key(args.key_template, args.bench_key, name, row, repeat, repeats)
                folder = eha.result_folder(out / name, key)
                outcome = materialise_run(rid, args.domain, row, inboxes, folder)
                if outcome[0] == 'ok':
                    entry['materialised'] += 1
                    entry['runs'].append({'rid': rid, 'folder': folder.name, 'sha256': outcome[1], 'source': outcome[2], 'meta': outcome[3]})
                else:
                    problems += 1
                    entry['notMaterialised'].append({'rid': rid, 'state': outcome[0], 'reason': outcome[1]})
        report['arms'][name] = entry
    out.mkdir(parents=True, exist_ok=True)
    (out / 'materialised.json').write_text(json.dumps(report, indent=1, ensure_ascii=False) + '\n', encoding='utf-8')
    return report, problems


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--registration', required=True)
    p.add_argument('--role', required=True, choices=['development', 'confirmation'])
    p.add_argument('--domain', required=True)
    p.add_argument('--bench-key', required=True)
    p.add_argument('--arm', action='append', required=True, help='NAME=PREFIX (baseline, aa or cand-<12 hex>)')
    p.add_argument('--form', default='dev', help='dev (<prefix>.<domain>.<row>.r<k>) or confirmation (cf.<domain>.<row>.<tag>.r<k>)')
    p.add_argument('--confirmation-prefix', default='cf', help='the leading token of a confirmation rid (default cf; a round that submitted under another, cf2, names it)')
    p.add_argument('--repeats', type=int, help='default: the registration\'s repeats for the role')
    p.add_argument('--key-template', default=eha.DEFAULT_KEY_TEMPLATE)
    p.add_argument('--inbox', action='append', help='directory of <rid>.tgz bundles (repeatable; default $H2_RUNS_ROOT/inbox and inbox/archive)')
    p.add_argument('--out', required=True)
    args = p.parse_args(argv)
    try:
        report, problems = run(args)
    except (MaterialiseError, rl.RoundError, eha.ExportError, OSError) as error:
        print(f'materialise_lane_bundles: {error}', file=sys.stderr)
        return 2
    for name, entry in report['arms'].items():
        print(f'{name} ({entry["prefix"]}): {entry["materialised"]}/{entry["expected"]} materialised'
              + (f'; not materialised {len(entry["notMaterialised"])}: ' + ', '.join(sorted({f"{x['state']}" for x in entry["notMaterialised"]})) if entry['notMaterialised'] else ''))
    if report['ignoredPrefixes']:
        print('ignored prefixes of this domain: ' + ', '.join(f'{k} ({v})' for k, v in report['ignoredPrefixes'].items()))
    return 3 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
