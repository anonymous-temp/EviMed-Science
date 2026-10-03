"""Source composition and evidence coverage; neither is a live-image observation."""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def enabled_manifests(root: Path) -> list[Path]:
    inventory = root / 'inventory.json'
    allowed = None
    if inventory.is_file():
        delivery = json.loads(inventory.read_text()).get('policy', {}).get('delivery', {})
        if delivery.get('contractVersion') != 1 or delivery.get('defaultEnabledTier') != 'executable' or not isinstance(delivery.get('executable'), dict):
            raise SystemExit('unsupported runtime skill delivery inventory: %s' % inventory)
        allowed = set(delivery['executable'])
    manifests = [root / 'SKILL.md'] if (root / 'SKILL.md').is_file() else sorted(root.glob('*/SKILL.md'))
    if root.name == 'geo-private':
        manifests = sorted((root / 'skills').glob('*/SKILL.md'))
    selected = [item for item in manifests if allowed is None or item.parent.name in allowed]
    if allowed is not None and {item.parent.name for item in selected} != allowed:
        raise SystemExit('executable inventory names missing skill bodies: %s' % inventory)
    return selected


def skill_composition(repo: Path) -> dict:
    dockerfile = repo / 'deploy/runtime-dsh/Dockerfile'
    installer = repo / 'deploy/runtime-dsh/install-runtime.sh'
    copies = re.findall(r'^COPY (\S+) (\S+)$', dockerfile.read_text(), re.M)
    preset = dict(re.findall(r'^\s*cp -a (\S+) (/opt/evimed/socket/presets/evimed-universal/skills/\S+)$', installer.read_text(), re.M))
    declared = re.findall(r"source: '([^']+)'", (repo / 'packages/domain/src/skillRoots.mjs').read_text())
    copied = dict(copies)
    if not declared or any(source not in copied for source in declared):
        raise SystemExit('declared skill roots are not copied into the runtime image')
    roots, packages = [], []
    for source, destination in copies:
        if not (destination.startswith(('/opt/evimed/skills/', '/usr/local/share/evimed/skills/')) or destination == '/opt/evimed/capability-skills'):
            continue
        root = repo / source
        if not root.is_dir():
            raise SystemExit('runtime image skill source is missing: %s' % source)
        scope = 'delegated' if source == 'capability-skills' else 'agent' if source.startswith('runtime/skills/evimed/') else 'global'
        inside = destination
        if scope != 'delegated':
            parent = next((item for item in preset if destination == item or destination.startswith(item + '/')), None)
            if parent is None:
                raise SystemExit('copied skill root never reaches the native preset: %s' % destination)
            inside = preset[parent] + destination[len(parent):]
        manifests = enabled_manifests(root)
        if any(manifest.is_symlink() or not manifest.resolve().is_relative_to(repo.resolve()) for manifest in manifests):
            raise SystemExit('skill composition contains an unbound manifest link: %s' % source)
        unselected = sorted(set(root.rglob('SKILL.md')) - set(manifests))
        policy_disabled = []
        unexplained = []
        for item in unselected:
            body = {'manifest': item.relative_to(repo).as_posix(), 'manifestSha256': sha256(item)}
            if (root / 'inventory.json').is_file() and item.parent.parent == root:
                policy_disabled.append(body)
            else:
                unexplained.append(body)
        roots.append({'source': source, 'imagePath': inside, 'scope': scope, 'sourceState': 'present' if manifests and not unexplained else 'unknown', 'packages': len(manifests), 'policyDisabledBodies': policy_disabled, 'unexplainedBodies': unexplained})
        for manifest in manifests:
            identifier = manifest.parent.relative_to(repo).as_posix()
            if identifier.startswith('runtime/skills/'):
                identifier = identifier[len('runtime/skills/'):]
            packages.append({'id': identifier, 'scope': scope, 'manifest': manifest.relative_to(repo).as_posix(), 'manifestSha256': sha256(manifest)})
    if set(declared) - {row['source'] for row in roots}:
        raise SystemExit('declared skill COPY has an unexplained destination')
    ids = [item['id'] for item in packages]
    if not roots or not packages or len(ids) != len(set(ids)):
        raise SystemExit('runtime image skill composition is empty or duplicated')
    return {'schemaVersion': 1, 'basis': 'source-planned-image-composition', 'imageObservation': 'unknown', 'personalGenerations': 'not-assessed', 'nativePluginSkills': 'not-assessed', 'domainDeclarationSha256': sha256(repo / 'packages/domain/src/skillRoots.mjs'), 'dockerfileSha256': sha256(dockerfile), 'installerSha256': sha256(installer), 'roots': roots, 'packages': sorted(packages, key=lambda row: row['id'])}


def validate_disabled(registry: set[str], optional: set[str], disabled) -> set[str]:
    if not isinstance(disabled, (list, set, frozenset)) or any(not isinstance(name, str) for name in disabled) or len(disabled) != len(set(disabled)):
        raise SystemExit('tool audit notOffered must contain unique tool names')
    disabled = set(disabled)
    if disabled - registry:
        raise SystemExit('tool audit disables unknown tools: ' + ', '.join(sorted(disabled - registry)))
    if disabled - optional:
        raise SystemExit('tool audit disables required tools: ' + ', '.join(sorted(disabled - optional)))
    return disabled


def _receipt_matches(repo: Path, receipt: dict) -> bool:
    path = repo / str(receipt.get('path', ''))
    resolved = path.resolve()
    return resolved.is_relative_to(repo.resolve()) and path.is_file() and not path.is_symlink() and path.stat().st_size > 0 and path.stat().st_size == receipt.get('bytes') and sha256(path) == receipt.get('sha256')


def skill_execution_coverage(repo: Path, results: Path, composition: dict) -> list[dict]:
    """Keep old packages historical; certify current bodies only with matching receipts."""
    packages = {row['id']: row for row in composition['packages']}
    certified = {}
    reasons = {}
    for filename, row_key in [('skill-execution-v1.json', 'skills'), ('platform-skill-execution-v1.json', 'packages')]:
        file = results / filename
        if not file.is_file():
            continue
        document = json.loads(file.read_text())
        try:
            observed = datetime.fromisoformat(str(document.get('finishedAt')).replace('Z', '+00:00'))
            fresh = datetime.now(timezone.utc) - timedelta(days=14) <= observed <= datetime.now(timezone.utc) + timedelta(minutes=5)
        except (ValueError, TypeError):
            fresh = False
        if document.get('schemaVersion') != 1 or not fresh:
            continue
        curated = row_key == 'skills'
        environment = document.get('environment', {})
        if curated:
            inventory = repo / 'runtime/skills/curated-scientific/inventory.json'
            engine = repo / 'runtime/skills/curated-scientific/_runtime/execute_skill.py'
            delivery = json.loads(inventory.read_text())['policy']['delivery']['executable']
            expected_dependencies = dict(dependency.split('==', 1) for descriptor in delivery.values() for dependency in descriptor.get('dependencies', []) if '==' in dependency)
            if environment.get('matchesInventory') is not True or any(environment.get('exactDependencies', {}).get(name) != version for name, version in expected_dependencies.items()) or document.get('inventorySha256') != sha256(inventory) or document.get('runtimeEngineSha256') != sha256(engine):
                continue
        elif environment.get('dependencyContract') != 'selected audit runtime plus package-declared dependencies':
            continue
        rows = document.get(row_key, [])
        if document.get('executionCertified') != sum(row.get('passed') is True for row in rows) or document.get('failed') != sum(row.get('passed') is not True for row in rows) or document.get('inventoryExecutable' if curated else 'installedPackagesExamined') != len(rows):
            continue
        # A retained batch with corrupt receipts cannot certify its other rows.
        if any(row.get('passed') is True and (row.get('returnCode') != 0 or not row.get('artifacts') or not all(_receipt_matches(repo, receipt) for receipt in row['artifacts'])) for row in rows):
            for row in rows:
                identifier = 'curated-scientific/%s' % row.get('skill') if curated else row.get('package')
                reasons[identifier] = 'retained-batch-artifact-integrity-unverified'
            continue
        identifiers = [row.get('skill' if curated else 'package') for row in rows]
        if len(identifiers) != len(set(identifiers)):
            continue
        for row in rows:
            identifier = 'curated-scientific/%s' % row.get('skill') if curated else row.get('package')
            package = packages.get(identifier)
            if package is None or row.get('passed') is not True or row.get('returnCode') != 0 or row.get('operation') != ('smoke-task' if curated else 'task'):
                continue
            if row.get('manifestSha256') != package['manifestSha256']:
                continue
            if curated:
                expected_paths = sorted((repo / package['manifest']).parent.joinpath(entrypoint).resolve().relative_to(repo.resolve()).as_posix() for entrypoint in delivery.get(row.get('skill'), {}).get('entrypoints', []))
                actual_receipts = row.get('entrypointReceipts', [])
                if not expected_paths or sorted(receipt.get('path', '') for receipt in actual_receipts) != expected_paths or not all(_receipt_matches(repo, receipt) for receipt in actual_receipts):
                    continue
            else:
                entrypoint = repo / str(row.get('entrypoint', ''))
                if row.get('manifestSha256') != package['manifestSha256'] or not entrypoint.resolve().is_relative_to(repo.resolve()) or not entrypoint.is_file() or sha256(entrypoint) != row.get('entrypointSha256') or not row.get('checks') or not all(row['checks'].values()):
                    continue
            receipts = row.get('artifacts', [])
            if row.get('artifactErrors') or len(receipts) < (2 if curated else 1) or not all(_receipt_matches(repo, receipt) for receipt in receipts):
                continue
            certified[identifier] = filename
    return [dict(packageId=identifier, state='bounded-historical-task-matched' if identifier in certified else 'unknown', currentImageExecution='unknown', fullPackageExecution='unknown', evidence=certified.get(identifier), reason=None if identifier in certified else reasons.get(identifier, 'no-current-matching-task-evidence')) for identifier in sorted(packages)]


def skill_evidence_metadata(results: Path) -> list[dict]:
    rows = []
    for name in ['skill-execution-v1.json', 'platform-skill-execution-v1.json']:
        file = results / name
        if not file.is_file():
            rows.append({'file': name, 'state': 'missing'})
            continue
        document = json.loads(file.read_text())
        rows.append({'file': name, 'sha256': sha256(file), 'startedAt': document.get('startedAt'), 'finishedAt': document.get('finishedAt'),
                     'environment': document.get('environment'), 'declaredTotals': {key: document.get(key) for key in ['inventoryExecutable', 'installedPackagesExamined', 'executionCertified', 'failed'] if key in document},
                     'claimBoundary': document.get('claimBoundary', document.get('certificationBoundary'))})
    return rows
