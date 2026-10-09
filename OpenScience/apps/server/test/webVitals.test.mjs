import test from 'node:test';
import assert from 'node:assert/strict';
import { WebVitals } from '../src/webVitals.mjs';
import { webVitalRoute } from '@evimed/domain';

test('vitals separate devices and routes, deduplicate updates, and expire rather than invent percentiles', () => {
  let now = 1_000;
  const metrics = new WebVitals(() => now);
  for (const [index, value] of [10, 20, 30, 40].entries()) metrics.record({ id: `desktop-${index}`, name: 'LCP', value, device: 'desktop', route: '/app/chat' });
  metrics.record({ id: 'mobile', name: 'LCP', value: 800, device: 'mobile', route: '/app/chat' });
  metrics.record({ id: 'mobile', name: 'LCP', value: 900, device: 'mobile', route: '/app/chat' });
  assert.deepEqual(metrics.snapshot().groups.map(row => [row.device, row.count, row.p75]), [['desktop', 4, 30], ['mobile', 1, 900]]);
  assert.throws(() => metrics.record({ id: 'x', name: 'LCP', value: 1, device: 'desktop', route: '/app/chat/private-session' }), { status: 400 });
  assert.equal(webVitalRoute('/app/files/private-document?query=private'), '/app/files');
  assert.equal(webVitalRoute('/app/virtual-research/private-study/analysis'), '/app/virtual-research');
  assert.equal(webVitalRoute('/app/extensions/skills/private-package'), '/app/extensions');
  assert.equal(webVitalRoute('/login?token=private'), null);
  now += 86_400_001;
  assert.deepEqual(metrics.snapshot().groups, []);
});
