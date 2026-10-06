import test from 'node:test';
import assert from 'node:assert/strict';
import {liveAcceptance} from '../../../scripts/ops/evolution-2-acceptance.mjs';
test('live acceptance refuses production and non-dedicated databases before loading secrets or calling models',async()=>{for(const databaseUrl of ['postgresql://postgres@example.com/evimed_test_evolution_2_live','postgresql://postgres@127.0.0.1:15479/evimed_test_evolution'])await assert.rejects(()=>liveAcceptance({databaseUrl,secretsDir:'/must-not-read',receiptFile:'/must-not-write'}),/isolated_test_database_required/);});
