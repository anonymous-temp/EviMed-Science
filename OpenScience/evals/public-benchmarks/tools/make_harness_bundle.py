#!/usr/bin/env python3
"""The harness-patch bundle of a candidate branch, and the identity of the image it was measured on.

  make_harness_bundle.py --repo ~/workspace/EviMedScience --base github/main --patch rsi-lab/patch-cstar \\
      --note-file rsi/round1/bundle-note.txt --title "cstar: ..." --image-id evimed-5c740327bb8c-1 \\
      --image-artifact rsi-lab-images-5c740327bb8c --out rsi/round1/bundles.json

Everything a candidate changes between rounds is an argument: the patch branch, the text appended to the supplement, the title, the image.

The bundle (`{guidanceSupplement, skills: []}`, the form export_harness_arms.py and the lab digest) is what the patch adds to the always-on
guidance: every line the branch adds to --guidance-path (a single-quoted or backtick string literal without an escape or an interpolation;
anything else is refused) with its leading indentation dropped, in file order, then --note / --note-file (the statement of a change that is
not guidance text, such as the run policy's clock). A branch that REMOVES a guidance line is refused unless --allow-removals: a bundle can
say what was added, not what was taken away, and the digest would then not describe the patch.

The image identity is {id, digest}. The lane bundles record no image digest (lane.json carries the image key only), so --image-digest is
given when one is known; otherwise the digest is sha256("<--image-artifact>|<patch commit>"), the CI artifact name of the release images
and the commit of the patch, and `digestSource` says so. A different patch commit is therefore a different image identity and a different
candidate arm.

Writes --out (`{"candidates": [{"title", "bundle"}]}`, the file export_harness_arms.py --bundles reads) and `<out stem>.identity.json`: the
patch ref and commit, the image, the arm id `cand-<12 hex>`, the digest and the sizes. Python 3.10 compatible; run with `python3 -I`.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))  # python -I does not put the script's directory on sys.path
import export_harness_arms as eha  # noqa: E402

DEFAULT_GUIDANCE = 'OpenScience/packages/socket/src/guidanceText.mjs'


class BundleError(Exception):
    pass


def git(repo, *words):
    done = subprocess.run(['git', '-C', str(repo), *words], capture_output=True, text=True)
    if done.returncode != 0:
        raise BundleError(f'git {" ".join(words[:2])} failed: {done.stderr.strip()[:300]}')
    return done.stdout


def literal_of(line):
    """The text of a one-line JS string literal (single quote or backtick, no escape, no interpolation), or None."""
    text = line.strip()
    if len(text) < 3 or text[0] not in "'`" or not (text.endswith(text[0] + ',') or text.endswith(text[0])):
        return None
    body = text[1:-2] if text.endswith(text[0] + ',') else text[1:-1]
    if '\\' in body or '${' in body or body[:1] in "'`" or text[0] in body:
        return None
    return body


def added_guidance(repo, base, patch, path, allow_removals):
    diff = git(repo, 'diff', '--unified=0', f'{base}...{patch}', '--', path)
    added, removed = [], 0
    for line in diff.splitlines():
        if line.startswith('+++') or line.startswith('---'):
            continue
        if line.startswith('+'):
            body = literal_of(line[1:])
            if body is None:
                raise BundleError(f'an added line of {path} is not a plain string literal: {line[1:60]!r}')
            added.append(body.strip())
        elif line.startswith('-'):
            removed += 1
    if removed and not allow_removals:
        raise BundleError(f'the patch removes {removed} line(s) of {path}; a bundle cannot say what was taken away (--allow-removals to record the added lines anyway)')
    if not added:
        raise BundleError(f'the patch adds no line to {path}')
    return added, removed


def build(args):
    commit = git(args.repo, 'rev-parse', '--verify', f'{args.patch}^{{commit}}').strip()
    base_commit = git(args.repo, 'merge-base', args.base, args.patch).strip()
    added, removed = added_guidance(args.repo, args.base, args.patch, args.guidance_path, args.allow_removals)
    note = args.note if args.note is not None else (pathlib.Path(args.note_file).read_text(encoding='utf-8').strip() if args.note_file else '')
    supplement = '\n'.join(added + ([note] if note else []))
    bundle = eha.normalize_bundle({'guidanceSupplement': supplement, 'skills': []})
    if args.image_digest:
        digest, source = args.image_digest, 'given'
    else:
        digest = hashlib.sha256(f'{args.image_artifact}|{commit}'.encode()).hexdigest()
        source = (f'no image digest is recorded in the lane bundles (lane.json carries the image key only); the digest is sha256("{args.image_artifact}|{commit}"), '
                  'the CI artifact name of the release images and the commit of the patch')
    image = eha.check_image({'id': args.image_id, 'digest': digest})
    out = pathlib.Path(args.out)
    document = {'candidates': [{'title': args.title, 'bundle': bundle}]}
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(document, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    (arm, record), = eha.candidate_arms(str(out), image).items()
    identity = {'patch': {'ref': args.patch, 'commit': commit, 'base': args.base, 'mergeBase': base_commit, 'guidancePath': args.guidance_path,
                          'addedLines': len(added), 'removedLines': removed, 'noteChars': len(note)},
                'image': {**image, 'digestSource': source}, 'arm': arm, 'harnessDigest': record['digest'], 'chars': record['chars'], 'alwaysOnChars': record['alwaysOnChars'],
                'title': args.title, 'bundlesSha256': hashlib.sha256(out.read_bytes()).hexdigest()}
    identity_path = out.with_name(out.stem + '.identity.json')
    identity_path.write_text(json.dumps(identity, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    return identity, identity_path


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    p.add_argument('--repo', required=True)
    p.add_argument('--base', default='github/main')
    p.add_argument('--patch', required=True)
    p.add_argument('--guidance-path', default=DEFAULT_GUIDANCE)
    p.add_argument('--note')
    p.add_argument('--note-file')
    p.add_argument('--allow-removals', action='store_true')
    p.add_argument('--title', required=True)
    p.add_argument('--image-id', required=True)
    p.add_argument('--image-artifact', required=True)
    p.add_argument('--image-digest')
    p.add_argument('--out', required=True)
    args = p.parse_args(argv)
    if args.note is not None and args.note_file:
        print('make_harness_bundle: give --note or --note-file, not both', file=sys.stderr)
        return 2
    try:
        identity, identity_path = build(args)
    except (BundleError, eha.ExportError, OSError) as error:
        print(f'make_harness_bundle: {error}', file=sys.stderr)
        return 2
    print(json.dumps({'arm': identity['arm'], 'commit': identity['patch']['commit'], 'imageDigest': identity['image']['digest'], 'alwaysOnChars': identity['alwaysOnChars'],
                      'files': [args.out, str(identity_path)]}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
