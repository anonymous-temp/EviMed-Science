import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const socketRequire = createRequire(new URL('../../../packages/socket/package.json', import.meta.url))

test('the final profile disables upstream citation registration and the preset supplies one managed provider', () => {
  const preset = readFileSync(path.join(root, 'packages/socket/presets/evimed-universal/agent.cordis.yml'), 'utf8')
  const bridge = preset.match(/^- id: evimed-citation-bridge\n[\s\S]*?(?=\n\n)/gm) ?? []
  assert.equal(bridge.length, 1)
  assert.match(bridge[0], /name: '@evimed\/dsh-socket\/plugins\/citation-bridge'/)
  assert.match(bridge[0], /gatewayUrl: !!js process.env.EVIMED_PUBLIC_SOURCE_GATEWAY_URL/)
  assert.match(bridge[0], /tokenFile: !!js process.env.EVIMED_MODEL_GATEWAY_TOKEN_FILE/)
  assert.doesNotMatch(preset, /^\s*name: ['"]?dsh-cite/m)
  const profile = readFileSync(path.join(root, 'deploy/runtime-dsh/build-smoke-patch.yml'), 'utf8')
  assert.match(profile, /^- id: cite\n  disabled: true$/m)
})

// Optional local seam proof: an existing pinned CLI image, never a build or an
// install. The normal suite still checks the profile/preset and native registry;
// this runs both historical bundle orders through the real DSH composition.
test('the pinned DSH composer disables the original provider after either bundle order', {
  skip: !process.env.EVIMED_CITATION_COMPOSITION_IMAGE,
}, () => {
  const citeRoot = path.dirname(realpathSync(socketRequire.resolve('dsh-cite/package.json')))
  const script = `
const fs = require('node:fs');
const cp = require('node:child_process');
const yaml = require('/app/harness/node_modules/js-yaml');
const schema = yaml.DEFAULT_SCHEMA.extend([new yaml.Type('tag:yaml.org,2002:js', {kind:'scalar',construct:value=>value})]);
const pin = JSON.parse(fs.readFileSync('/repo/deps-version.json')).dsh;
const cli = '/app/harness/node_modules/.bin/dsh';
if (cp.execFileSync(cli, ['--version'], {encoding:'utf8'}).trim() !== pin.version) throw Error('CLI pin mismatch');
const results = [];
for (const order of [['@evimed/dsh-socket','dsh-cite'], ['dsh-cite','@evimed/dsh-socket']]) {
  const home = fs.mkdtempSync('/tmp/citation-composition-');
  const dir = home + '/profiles/evimed-runtime';
  fs.mkdirSync(dir + '/node_modules/@evimed', {recursive:true});
  const bundles = ['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app', ...order];
  fs.writeFileSync(dir + '/package.json', JSON.stringify({dsh:{profile:{bundles}}}));
  fs.symlinkSync('/app/harness/node_modules/@deepseek-ai', dir + '/node_modules/@deepseek-ai');
  fs.symlinkSync('/repo/packages/socket', dir + '/node_modules/@evimed/dsh-socket');
  fs.symlinkSync('/cite', dir + '/node_modules/dsh-cite');
  const env = {...process.env, DSH_HOME:home};
  const dump = (extra=[]) => yaml.load(cp.execFileSync(cli, ['--profile','evimed-runtime','--dump-config', ...extra], {env,encoding:'utf8',timeout:10000}), {schema});
  const original = dump().filter(row => row.id === 'cite');
  if (original.length !== 1 || original[0].name !== 'dsh-cite' || original[0].disabled) throw Error('upstream fixture missing');
  const composed = dump(['--patch','/repo/deploy/runtime-dsh/build-smoke-patch.yml']);
  const citations = composed.filter(row => row.id === 'cite');
  if (citations.length !== 1 || citations[0].disabled !== true) throw Error('direct citation registration remains');
  results.push({order, original:original[0].name, disabled:citations[0].disabled});
  fs.rmSync(home, {recursive:true});
}
process.stdout.write(JSON.stringify(results));
`
  const output = execFileSync('docker', ['run', '--rm', '-i', '--network', 'none', '--entrypoint', 'node',
    '-v', `${root}:/repo:ro`, '-v', `${citeRoot}:/cite:ro`,
    process.env.EVIMED_CITATION_COMPOSITION_IMAGE, '-'], { input: script, encoding: 'utf8', timeout: 30000 })
  const results = JSON.parse(output)
  assert.equal(results.length, 2)
  assert.ok(results.every((row) => row.original === 'dsh-cite' && row.disabled === true))
})
