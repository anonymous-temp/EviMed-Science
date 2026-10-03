import assert from 'node:assert/strict';
import test from 'node:test';
import {createManagedBrowserResolver} from '../src/managedBrowserDns.mjs';

const edge = {url: new URL('https://proxy.example.org'),authorization:'synthetic-test-only',hosts:new Set(),connectTimeoutMs:1000};
const answer = (type, data = type === 1 ? '142.250.196.4' : '2607:f8b0:4004:c07::63') => new Response(JSON.stringify({Status:0,Answer:[{type,data,TTL:30}]}), {headers:{'content-type':'application/dns-json'}});

test('browser DNS travels over the fixed TLS resolver through Tokyo and caches only bounded checked answers',async()=>{
 let time=0;const calls=[];
 const resolve=createManagedBrowserResolver(edge,{now:()=>time,fetchImpl:async(actual,url,options)=>{
  assert.equal(actual,edge);assert.equal(url.origin,'https://cloudflare-dns.com');assert.equal(url.pathname,'/dns-query');
  assert.equal(options.headers.accept,'application/dns-json');assert(options.signal);calls.push(url.href);
  return answer(Number(url.searchParams.get('type')));
 }});
 const [first,duplicate]=await Promise.all([resolve('www.google.com'),resolve('www.google.com')]);
 assert.deepEqual(first,duplicate);assert.equal(calls.length,2);assert.equal(first.length,2);
 first[0].address='127.0.0.1';assert.notEqual((await resolve('www.google.com'))[0].address,'127.0.0.1');
 time=31000;await resolve('www.google.com');assert.equal(calls.length,4);
});

test('private answers, partial DNS failures, large or redirected resolver responses cannot become a destination',async()=>{
 for(const fixture of [
  async(_edge,url)=>answer(Number(url.searchParams.get('type')),'127.0.0.1'),
  async(_edge,url)=>{if(url.searchParams.get('type')==='28')throw Error('unavailable');return answer(1);},
  async()=>new Response('x'.repeat(16385),{headers:{'content-type':'application/json'}}),
  async()=>new Response('',{status:302,headers:{location:'http://internal'}}),
  async()=>new Response(JSON.stringify({Status:0,TC:true,Answer:[]}),{headers:{'content-type':'application/json'}}),
 ]){
  await assert.rejects(createManagedBrowserResolver(edge,{fetchImpl:fixture})('public.example.org'),{code:'web_read_host_unresolved'});
 }
});

test('private names and unsupported input do not query DNS; public address literals need no lookup',async()=>{
 let calls=0;const resolve=createManagedBrowserResolver(edge,{fetchImpl:async()=>{calls++;throw Error();}});
 for(const name of ['localhost','169.254.169.254','127.0.0.1','service.internal','a'.repeat(254),'https://example.org','[::1]'])await assert.rejects(resolve(name));
 assert.deepEqual(await resolve('93.184.216.34'),[{address:'93.184.216.34',family:4}]);assert.equal(calls,0);
});
