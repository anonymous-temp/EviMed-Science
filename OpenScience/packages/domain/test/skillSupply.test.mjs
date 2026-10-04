// A skill package's record: what it is, where it came from, what it needs, and whether this deployment can supply
// it. What these pin is the row's named failure cases: installed is not runnable when software or weights are
// missing, a source an upstream did not supply stays unknown, a dependency read from a package's own files says it
// was observed, and nothing here ever decides anything but a label.
import assert from 'node:assert/strict'
import test from 'node:test'

import * as domain from '../index.mjs'

const {
  buildSkillPackageRecord, declaredDependencies, describeSkillLicence, describeSkillSource, fencedPython, imageProvides, normalizeSkillPackageRecord,
  pinHolds, projectAvailability, publicSkillPackage, pythonImports, rLibraries, skillDependencyReasons, skillPackageRecordDigest, unknownFields,
  availabilityReasonState, describeAvailability, AVAILABILITY_REASON_CODES,
} = domain
const build = /** @type {(input: any) => any} */ (buildSkillPackageRecord)
const normalize = /** @type {(value: unknown) => any} */ (normalizeSkillPackageRecord)
const reasonsOf = /** @type {(record: any, facts: any) => any[]} */ (skillDependencyReasons)

const sha = (/** @type {string} */ char) => char.repeat(64)
const recipe = {
  python: { numpy: '2.2.6', scipy: '1.15.3', pandas: '2.2.3', pillow: '10.4.0' },
  modules: { numpy: ['numpy'], scipy: ['scipy'], pandas: ['pandas', 'pytz'], pillow: ['PIL'] },
  apt: ['git', 'python3', 'r-base-core', 'r-recommended', 'fonts-noto-cjk'],
  tools: ['pandoc', 'rg', 'python', 'Rscript'],
  rPackages: ['stats', 'survival', 'MASS'],
}
const facts = (/** @type {Record<string, any>} */ over = {}) => ({ image: recipe, tools: () => ({ offered: true }), deployment: new Set(), ...over })

test('a record is rebuilt field by field: anything else the input carries does not survive, and a record of another schema is absent', () => {
  const record = build({ id: 'curated/x', name: 'x', origin: 'curated', files: [{ path: 'SKILL.md', sha256: sha('a') }], digest: `sha256:${sha('b')}` })
  assert.equal(record.schemaVersion, 1)
  const smuggled = normalize({ ...record, authority: 'root', source: { kind: 'release', hostPath: '/etc' } })
  assert.equal(smuggled.authority, undefined)
  assert.deepEqual(smuggled.source, { kind: 'release', repository: null, commit: null, path: null, package: null, digest: null })
  assert.equal(normalize({ ...record, schemaVersion: 2 }), null)
  assert.equal(normalize({ ...record, origin: 'marketplace' }), null)
  assert.equal(normalize(null), null)
  assert.equal(normalize({ ...record, id: 'bad id with spaces' }), null)
})

test('unknown is a value: nothing is synthesized for a licence, a version or a commit the upstream did not supply', () => {
  const record = build({ id: 'curated/x', name: 'x', origin: 'curated', files: [{ path: 'SKILL.md', sha256: sha('a') }] })
  assert.equal(record.version, null)
  assert.equal(record.source, null)
  assert.equal(record.licence, null)
  assert.equal(record.digest, null)
  assert.deepEqual(unknownFields(record).map((entry) => entry.field), ['version', 'source', 'licence', 'digest'])
  assert.equal(describeSkillLicence(record.licence), '许可证未记录')
  assert.equal(describeSkillSource(record.source), '来源未记录')
  // A package derived from a reviewed one, with no commit recorded, says exactly that.
  const derived = build({ id: 'curated/y', name: 'y', origin: 'curated', files: [], source: { kind: 'derived', package: 'scientific-agent-skills', path: 'database-lookup' } })
  assert.ok(unknownFields(derived).some((entry) => entry.field === 'source.commit'))
  assert.match(describeSkillSource(derived.source), /提交未记录/)
  // A licence file without a declared name is not "MIT".
  const filed = build({ id: 'core/z', name: 'z', origin: 'core', files: [{ path: 'LICENSE', sha256: sha('c') }] })
  assert.equal(filed.licence.id, null)
  assert.equal(filed.licence.basis, 'file-present')
  assert.equal(describeSkillLicence(filed.licence), '含许可证文件，名称未声明')
  assert.ok(unknownFields(filed).some((entry) => entry.field === 'licence'))
})

test('an exact repository source needs both its repository and its full commit, or it is not an exact source', () => {
  const exact = build({ id: 'community/a', name: 'a', origin: 'community', files: [], source: { kind: 'repository', repository: 'owner/skill', commit: 'a'.repeat(40), path: 'skills/a' } })
  assert.equal(exact.source.commit, 'a'.repeat(40))
  assert.match(describeSkillSource(exact.source), /owner\/skill @ aaaaaaaaaaaa（skills\/a）/)
  const short = build({ id: 'community/a', name: 'a', origin: 'community', files: [], source: { kind: 'repository', repository: 'owner/skill', commit: 'abc123' } })
  assert.equal(short.source, null, 'a short commit is dropped, not softened')
  assert.equal(build({ id: 'personal/a', name: 'a', origin: 'personal', files: [], source: { kind: 'upload' } }).source, null, 'an upload needs its digest')
})

test('scripts, references and the licence file are told apart from the package files, and paths cannot leave the package', () => {
  const record = build({
    id: 'curated/x', name: 'x', origin: 'curated',
    files: [
      { path: 'SKILL.md', sha256: sha('1') }, { path: 'scripts/run.py', sha256: sha('2') }, { path: 'scripts/plot.R', sha256: sha('3') },
      { path: 'references/notes.md', sha256: sha('4') }, { path: 'LICENSE.upstream', sha256: sha('5') }, { path: '../escape.py', sha256: sha('6') }, { path: '/abs.py', sha256: sha('7') },
    ],
  })
  assert.deepEqual(record.scripts.map((/** @type {any} */ file) => file.path), ['scripts/plot.R', 'scripts/run.py'])
  assert.deepEqual(record.references.map((/** @type {any} */ file) => file.path), ['references/notes.md'])
  assert.equal(record.licence.file.path, 'LICENSE.upstream')
})

test('python imports are read as statements: top level is needed, nested is a path, the standard library and a package\'s own modules are not dependencies', () => {
  const source = [
    '"""A docstring that says import nothing_here."""',
    'from __future__ import annotations',
    'import json, os',
    'import numpy as np',
    'from scipy import stats',
    'from .sibling import thing',
    'import helper',
    '# import commented_out',
    'try:',
    '    import gseapy as gp',
    'except ImportError:',
    '    gp = None',
    'def f():',
    '    from statsmodels.api import OLS',
    '    import numpy',
    "x = '''",
    'import inside_a_string',
    "'''",
  ].join('\n')
  const found = pythonImports(source, { localModules: ['helper'] })
  assert.deepEqual(found.required, ['numpy', 'scipy'])
  assert.deepEqual(found.optional, ['gseapy', 'statsmodels'])
  assert.deepEqual(pythonImports('import sys\nimport os.path\n').required, [])
  // Instructions: only the code fences count, and everything in them is a path.
  const markdown = 'Use it.\n\n```python\nimport rdkit\nfrom rdkit import Chem\n```\n\n```bash\nuv pip install nothing\n```\nimport not_code\n'
  assert.deepEqual(pythonImports(fencedPython(markdown)).required, ['rdkit'])
  assert.deepEqual(rLibraries('library(survival)\nrequire("MASS")\n# library(commented)\nx <- jsonlite::fromJSON(y)\n'), ['MASS', 'jsonlite', 'survival'])
})

test('observed dependencies carry where they were seen, and a script import is never claimed as a pin', () => {
  const record = build({
    id: 'core/x', name: 'x', origin: 'core',
    files: [
      { path: 'scripts/probe.py', sha256: sha('1'), text: 'import numpy\ntry:\n    import h5py\nexcept ImportError:\n    pass\n' },
      { path: 'SKILL.md', sha256: sha('2'), text: '```python\nimport rdkit\n```\n' },
    ],
  })
  const byName = Object.fromEntries(record.dependencies.map((/** @type {any} */ dependency) => [dependency.name, dependency]))
  assert.deepEqual({ ...byName.numpy, evidence: byName.numpy.evidence }, { kind: 'python-package', name: 'numpy', constraint: null, supply: 'image', optional: false, basis: 'observed', evidence: 'scripts/probe.py' })
  assert.equal(byName.h5py.optional, true)
  assert.equal(byName.rdkit.optional, true)
  assert.match(byName.rdkit.evidence, /instructions/)
  assert.ok(record.dependencies.every((/** @type {any} */ dependency) => dependency.constraint === null))
})

test('a declaration outranks an observation of the same dependency and keeps its pin', () => {
  const record = build({
    id: 'curated/x', name: 'x', origin: 'curated',
    files: [{ path: 'scripts/run.py', sha256: sha('1'), text: 'import numpy\n' }],
    dependencies: [{ kind: 'python-package', name: 'numpy', constraint: '==2.2.6', basis: 'declared', evidence: 'inventory' }],
  })
  const numpy = record.dependencies.find((/** @type {any} */ dependency) => dependency.name === 'numpy')
  assert.equal(record.dependencies.length, 1)
  assert.equal(numpy.basis, 'declared')
  assert.equal(numpy.constraint, '==2.2.6')
  assert.equal(numpy.optional, false)
})

test('metadata.requires declares dependencies of every kind, and an entry that does not read is dropped', () => {
  const declared = declaredDependencies({ requires: { python: ['numpy==2.2.6', 'rdkit', 'bad entry!!'], r: ['survival'], tools: ['pandoc'], weights: ['esm2-650m'], data: ['gnomad-v4'], compute: ['gpu'], platformTools: ['literature_search'] } })
  const by = Object.fromEntries(declared.map((/** @type {any} */ dependency) => [dependency.name, dependency]))
  assert.equal(by.numpy.constraint, '==2.2.6')
  assert.equal(by.rdkit.constraint, null)
  assert.equal(by['esm2-650m'].supply, 'deployment', 'weights are mounted by the deployment')
  assert.equal(by['gnomad-v4'].supply, 'researcher', 'a dataset is the researcher\'s own, supplied at use')
  assert.equal(by.gpu.supply, 'researcher')
  assert.equal(by.literature_search.supply, 'platform')
  assert.equal(declared.find((/** @type {any} */ dependency) => dependency.name.includes('bad')), undefined)
  assert.deepEqual(declaredDependencies({ requires: 'x' }), [])
  assert.deepEqual(declaredDependencies(undefined), [])
})

test('the image recipe answers for python libraries by distribution or module, for R packages, tools and apt packages; an absent recipe answers nothing', () => {
  const dep = (/** @type {string} */ kind, /** @type {string} */ name, /** @type {string | null} */ constraint = null) => ({ kind, name, constraint, supply: 'image', optional: false, basis: 'declared', evidence: null })
  assert.deepEqual(imageProvides(recipe, /** @type {any} */ (dep('python-package', 'numpy'))), { present: true, version: '2.2.6' })
  assert.deepEqual(imageProvides(recipe, /** @type {any} */ (dep('python-package', 'PIL'))), { present: true, version: '10.4.0' }, 'a module name finds its distribution')
  assert.deepEqual(imageProvides(recipe, /** @type {any} */ (dep('python-package', 'Pillow'))), { present: true, version: '10.4.0' }, 'a distribution name is case-folded')
  assert.deepEqual(imageProvides(recipe, /** @type {any} */ (dep('python-package', 'rdkit'))), { present: false, version: null })
  assert.equal(imageProvides(recipe, /** @type {any} */ (dep('r-package', 'survival'))).present, true)
  assert.equal(imageProvides(recipe, /** @type {any} */ (dep('r-package', 'lme4'))).present, false)
  assert.equal(imageProvides(recipe, /** @type {any} */ (dep('system-tool', 'pandoc'))).present, true)
  assert.equal(imageProvides(recipe, /** @type {any} */ (dep('system-tool', 'fonts-noto-cjk'))).present, true)
  assert.equal(imageProvides(recipe, /** @type {any} */ (dep('system-tool', 'python3'))).present, true)
  assert.equal(imageProvides(recipe, /** @type {any} */ (dep('system-tool', 'samtools'))).present, false)
  assert.equal(imageProvides(null, /** @type {any} */ (dep('python-package', 'numpy'))).present, null, 'an absent recipe is "cannot say", never "fine"')
  assert.equal(pinHolds('==2.2.6', '2.2.6'), true)
  assert.equal(pinHolds('==2.2.7', '2.2.6'), false)
  assert.equal(pinHolds('>=3.11', '3.12'), null, 'a range is the image builder\'s statement, not evaluated here')
})

test('missing software, an unoffered tool and absent weights are named; what the researcher supplies is never a reason', () => {
  const record = build({
    id: 'curated/x', name: 'x', origin: 'curated', files: [],
    dependencies: [
      { kind: 'python-package', name: 'numpy', constraint: '==2.2.6' },
      { kind: 'python-package', name: 'scipy', constraint: '==1.9.0' },
      { kind: 'python-package', name: 'rdkit' },
      { kind: 'system-tool', name: 'samtools', optional: true },
      { kind: 'platform-tool', name: 'literature_search' },
      { kind: 'platform-tool', name: 'vcr_read', optional: true },
      { kind: 'model-weights', name: 'esm2-650m' },
      { kind: 'dataset', name: 'my-cohort' },
      { kind: 'compute', name: 'gpu' },
    ],
  })
  const reasons = reasonsOf(record, facts({ tools: (/** @type {string} */ tool) => (tool === 'vcr_read' ? { offered: false, why: 'module-off' } : { offered: true }) }))
  const summary = Object.fromEntries(reasons.map((reason) => [`${reason.code}:${reason.detail}`, reason]))
  assert.deepEqual(Object.keys(summary).sort(), [
    'dependency-data-missing:esm2-650m', 'dependency-software-missing:rdkit', 'dependency-software-missing:samtools',
    'dependency-version-differs:scipy', 'optional-tool-not-offered:vcr_read',
  ])
  assert.equal(summary['dependency-version-differs:scipy'].facts.have, '1.15.3')
  assert.equal(summary['dependency-software-missing:samtools'].optional, true)
  // Required ones sort first, so the deciding reason is the one that blocks.
  assert.equal(reasons[0].optional, false)
  assert.equal(reasons.at(-1).optional, true)
})

test('a fact that was not read is unchecked, never present: no recipe, no tool answer, no deployment inventory', () => {
  const record = build({ id: 'curated/x', name: 'x', origin: 'curated', files: [], dependencies: [
    { kind: 'python-package', name: 'numpy' }, { kind: 'platform-tool', name: 'literature_search' }, { kind: 'model-weights', name: 'esm2-650m' },
  ] })
  const reasons = reasonsOf(record, { image: null, tools: null, deployment: null })
  assert.deepEqual(reasons.map((reason) => reason.code), ['dependency-unchecked', 'dependency-unchecked', 'dependency-unchecked'])
  assert.deepEqual(reasonsOf(record, facts()).map((reason) => reason.code), ['dependency-data-missing'])
})

test('the availability ladder reads the reasons: missing software limits, unchecked is unverified, optional or researcher-supplied leaves it installed', () => {
  const record = build({ id: 'curated/cheminformatics', name: 'cheminformatics', origin: 'curated', version: '1', files: [], dependencies: [
    { kind: 'python-package', name: 'rdkit', basis: 'declared', evidence: 'SKILL.md' }, { kind: 'python-package', name: 'h5py', optional: true },
  ] })
  const reasons = reasonsOf(record, facts())
  const required = reasons.filter((reason) => !reason.optional)
  const entry = projectAvailability({ subject: { kind: 'skill', id: 'cheminformatics', version: '1' }, reasons: required, collector: { state: 'ready' } })
  assert.equal(entry.state, 'limited')
  assert.equal(entry.reason.code, 'dependency-software-missing')
  assert.match(entry.text, /rdkit/)
  assert.match(entry.text, /其余部分照常/, 'it says what still works, so "limited" is not read as "broken"')
  const optionalOnly = projectAvailability({ subject: { kind: 'skill', id: 'x' }, reasons: [], collector: { state: 'ready' } })
  assert.equal(optionalOnly.state, 'installed')
  const unchecked = projectAvailability({ subject: { kind: 'skill', id: 'x' }, reasons: reasonsOf(build({ id: 'a/b', name: 'b', origin: 'core', files: [], dependencies: [{ kind: 'python-package', name: 'numpy' }] }), { image: null, tools: null, deployment: null }), collector: { state: 'ready' } })
  assert.equal(unchecked.state, 'unverified')
  assert.match(unchecked.text, /无法确认/)
  const version = projectAvailability({ subject: { kind: 'skill', id: 'x' }, reasons: [{ code: 'dependency-version-differs', detail: 'scipy', source: 'image-recipe', facts: { wanted: '==1.9.0', have: '1.15.3' } }], collector: { state: 'ready' } })
  assert.match(version.text, /scipy.*==1\.9\.0.*1\.15\.3/)
})

test('every new reason code is in the table, names one state and has a sentence in the product\'s words', () => {
  for (const code of ['dependency-software-missing', 'dependency-version-differs', 'dependency-data-missing', 'dependency-unchecked']) {
    assert.ok(AVAILABILITY_REASON_CODES.includes(code), code)
    const state = availabilityReasonState(code)
    assert.ok(state)
    const { text } = describeAvailability({ kind: 'skill', version: null, state, reason: { code, detail: 'x', source: 'image-recipe' }, operations: null })
    assert.match(text, /[一-鿿]/)
  }
  assert.equal(availabilityReasonState('dependency-software-missing'), 'limited')
  assert.equal(availabilityReasonState('dependency-unchecked'), 'unverified')
})

test('the public view of a record names the unknowns and carries no file digests', () => {
  const record = build({ id: 'curated/x', name: 'x', origin: 'curated', files: [{ path: 'scripts/a.py', sha256: sha('1') }], source: { kind: 'derived', package: 'upstream' } })
  const view = /** @type {any} */ (publicSkillPackage(record))
  assert.equal(view.scripts, 1)
  assert.equal(view.sourceText, '派生自 upstream，提交未记录')
  assert.ok(view.unknown.length >= 3)
  assert.equal(JSON.stringify(view).includes(sha('1')), false)
  assert.equal(publicSkillPackage(null), null)
  assert.match(skillPackageRecordDigest(record, () => sha('9')), /^sha256:9{64}$/)
})
