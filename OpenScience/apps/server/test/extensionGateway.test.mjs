import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createExtensionInvocationResolver, createExtensionGatewayHandler } from '../src/extensionGateway.mjs';
import { createRuntimeGatewayEntry, resolveRuntimeGatewayPath } from '../src/runtimeGatewayEntry.mjs';
async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return `http://127.0.0.1:${server.address().port}`;
}
test('gateway rechecks current workload token after request hydration; body principal cannot select actor', async t => {
  let checks = 0,
    called = 0;
  const handler = createExtensionGatewayHandler({
    runtimeManager: {
      assertActiveEviMedWorkloadToken: async () => {
        if (++checks === 2) throw Object.assign(Error('expired'), {
          status: 401,
          code: 'unauthorized'
        });
        return {
          userId: 'alice',
          projectId: 'p',
          runtimeGeneration: 'r'
        };
      }
    },
    service: {
      submit: async () => {
        called++;
        return {};
      }
    }
  });
  const url = await serve(t, (req, res) => void handler(req, res));
  const response = await fetch(url + '/internal/extensions/v1/execute', {
    method: 'POST',
    headers: {
      authorization: 'Bearer bounded-workload'
    },
    body: JSON.stringify({
      userId: 'bob',
      descriptorId: 'cowork',
      request: {
        operation: 'doc_read',
        resourceId: 'public_one'
      }
    })
  });
  assert.equal(response.status, 401);
  assert.equal(called, 0);
});
test('extension public prefix demands workload token and never accepts a model token', async t => {
  assert.deepEqual(resolveRuntimeGatewayPath('/runtime-gateway/extensions/v1/execute'), {
    kind: 'internal',
    url: '/internal/extensions/v1/execute'
  });
  const entry = createRuntimeGatewayEntry({
    config: {
      runtimeProvider: 'agentbay',
      runtimeGatewayPublicUrl: 'https://fixture.invalid/runtime-gateway'
    },
    runtimeManager: {
      assertActiveModelGatewayToken: () => ({
        userId: 'alice',
        projectId: 'p'
      }),
      assertActiveEviMedWorkloadToken: async () => {
        throw Error('not workload');
      }
    }
  });
  const url = await serve(t, async (req, res) => {
    if (await entry.handle(req, res)) return;
    res.end('must not dispatch');
  });
  assert.equal((await fetch(url + '/runtime-gateway/extensions/v1/execute', {
    method: 'POST',
    headers: {
      authorization: 'Bearer model-only'
    }
  })).status, 401);
});
test('claimed foreign or child call IDs never acquire a trusted invocation without exact current facts', async () => {
  const request = {
      operation: 'doc_read',
      resourceId: 'public_one'
    },
    auth = {
      userId: 'alice',
      projectId: 'p',
      runtimeGeneration: 'r'
    },
    invocation = {
      sessionId: 'session',
      callId: 'child-call',
      rootCallId: 'root-call',
      agentId: 'child',
      toolName: 'doc_read',
      runtimeGeneration: 'r'
    };
  const resolve = createExtensionInvocationResolver({
    lookup: async () => null
  });
  await assert.rejects(resolve(auth, invocation, request), {
    code: 'extension_access_denied'
  });
  const forged = {
    ...invocation,
    toolPermitted: true
  };
  await assert.rejects(resolve(auth, forged, request), {
    code: 'extension_access_denied'
  });
});

test('a body held past the bounded deadline is closed before durable admission', async t => {
  let admitted = 0;
  const handler = createExtensionGatewayHandler({bodyTimeoutMs:100,runtimeManager:{assertActiveEviMedWorkloadToken:async()=>({userId:'alice',projectId:'p',runtimeGeneration:'r'})},service:{submit:async()=>{admitted++;}}});
  const url = await serve(t,(req,res)=>void handler(req,res));
  await new Promise(resolve=>{const request=http.request(url+'/internal/extensions/v1/execute',{method:'POST',headers:{authorization:'Bearer workload','transfer-encoding':'chunked'}});request.on('error',resolve);request.on('response',response=>{response.resume();response.on('end',resolve)});request.write('{');});
  assert.equal(admitted,0);
});
