// Run inside a profile after every bundle was removed: the plugin entries must not resolve any more.
import assert from 'node:assert/strict'
for (const id of process.argv.slice(2)) {
  await assert.rejects(() => import(`@evimed/${id}/plugin`), /Cannot find|ERR_MODULE_NOT_FOUND|ERR_PACKAGE_PATH/, `${id} still resolves after removal`)
}
console.log('absent ok')
