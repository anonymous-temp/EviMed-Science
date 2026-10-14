/**
 * A digest-bound compatibility patch applied only while building the immutable profile.
 *
 * What it adapts. `@changfenhuang/dsh-annotation` 1.4.11 chooses its interface language from the kernel's locale service
 * with an exact match: `zh`, `en` and `ru` are taken as they are and every other id is English (its own test pins this
 * for `fr`, `de` and `zh-Hans`). The product's active locale is `zh-x-evimed` — Simplified Chinese with the product's own
 * words over the kernel's dictionary — so the whole annotation interface, and the block it writes into the prompt, turned
 * English on the pin that brought 1.4.11. The bundle chooses by the primary language subtag here instead, which is what
 * the kernel's own locale service already does for `ru-RU`. Nothing else in the bundle changes.
 *
 * Why here and not in the frame layer. The bundle reads `ctx.locale.getSnapshot().active`; presenting it a different id
 * would mean the product's dictionary no longer applies to the rest of the frame, and the product's locale is the frame's
 * contract. A one-line, byte-verified edit of the pinned bytes is the narrowest adapter, and it carries its own end date.
 *
 * The edit is verified against the reviewed bytes (`deps-version.json` `dsh.annotationCompatibility`) before and after:
 * a changed byte fails the image build by name, and a second application over its own output verifies the reverse
 * transformation first, so a derived-image build that prepares the profile again lands on the same file.
 */
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const original = "currentLang = (id === 'zh' || id === 'en' || id === 'ru') ? id : 'en'";
const replacement = "currentLang = (function (tag) { var primary = String(tag).toLowerCase().split('-')[0]; return (primary === 'zh' || primary === 'en' || primary === 'ru') ? primary : 'en' })(id)";

const hash = text => createHash('sha256').update(text).digest('hex');

/**
 * @param {{ pluginDir: string, pin: { annotationVersion: string, annotationCompatibility: { file: string, sha256: string } } }} input
 *   `pin` is the `dsh` object of `deps-version.json`
 */
export function adaptAnnotationLocale({ pluginDir, pin }) {
  const compatibility = pin.annotationCompatibility;
  if (!compatibility?.file || !/^[0-9a-f]{64}$/.test(String(compatibility.sha256))) {
    throw new Error('deps-version.json carries no annotationCompatibility record for the annotation bundle.');
  }
  const installedVersion = JSON.parse(readFileSync(path.join(pluginDir, 'package.json'), 'utf8')).version;
  if (installedVersion !== pin.annotationVersion) {
    throw new Error(`The annotation bundle is ${installedVersion}, not the pinned ${pin.annotationVersion}; the compatibility edit was reviewed for the pin only.`);
  }
  const file = path.join(pluginDir, compatibility.file);
  const installed = readFileSync(file, 'utf8');
  const body = installed.includes(replacement) ? installed.replace(replacement, original) : installed;
  if (hash(body) !== compatibility.sha256 || body.split(original).length !== 2) {
    throw new Error('The annotation client differs from the reviewed compatibility input.');
  }
  const adapted = body.replace(original, replacement);
  // pnpm hard-links package files from its content store: a write through the link would change the store's copy as
  // well. The adapted file is a new file in the profile's own tree, and the store keeps the reviewed bytes.
  unlinkSync(file);
  writeFileSync(file, adapted);
  const receipt = {
    schemaVersion: 1,
    adaptation: 'locale-primary-subtag',
    upstreamVersion: pin.annotationVersion,
    file: compatibility.file,
    sourceSha256: compatibility.sha256,
    adaptedSha256: hash(adapted),
  };
  writeFileSync(path.join(pluginDir, 'evimed-compatibility.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pins = JSON.parse(readFileSync(process.argv[3] ?? '/opt/evimed/runtime-deps-version.json', 'utf8'));
  adaptAnnotationLocale({ pluginDir: process.argv[2], pin: pins.dsh });
}
