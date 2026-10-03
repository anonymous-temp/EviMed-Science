import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';
import {parse} from 'yaml';

test('interactive browser is confined to its dedicated internal network with no data or control mounts',async()=>{
 const document=parse(await fs.readFile(new URL('../../../deploy/web/docker-compose.browser.yml',import.meta.url),'utf8'));
 const browser=document.services['managed-browser'];
 assert.deepEqual(browser.networks,['managed-browser-internal']);
 assert.equal(document.networks['managed-browser-internal'].internal,true);
 assert.deepEqual(document.services['open-science-web'].networks,['managed-browser-internal']);
 assert.equal(browser.ports,undefined);assert.equal(browser.volumes,undefined);
 assert.equal(browser.read_only,true);assert.deepEqual(browser.cap_drop,['ALL']);
 assert.deepEqual(browser.security_opt,['no-new-privileges:true']);
 assert.equal(browser.user,'10003:10003');assert.equal(browser.mem_limit,'1g');
 assert(browser.tmpfs.some(value=>value.startsWith('/workspace:ro,')));
 assert(browser.tmpfs.some(value=>value.startsWith('/runtime:ro,')));
 assert.match(browser.command[0],/disable_non_proxied_udp/);
 assert.match(browser.command[0],/--disable-quic/);
 const script=await fs.readFile(new URL('../../../scripts/ops/host-release-switch.sh',import.meta.url),'utf8');
 assert(script.indexOf('COMPOSE+=(-f docker-compose.browser.yml)')>script.indexOf('COMPOSE+=(-f "$OVERRIDE")'));
});
