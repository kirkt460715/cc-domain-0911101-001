import test from 'node:test';
import assert from 'node:assert/strict';
import { createSource } from '../src/source.js';
async function setup(t){const source=createSource();const origin=await source.listen();t.after(()=>source.close());return origin;}
const control=(origin,data)=>fetch(origin+'/__control/state',{method:'POST',body:JSON.stringify(data)});
test('分页共享一项且导航为相对链接',async t=>{const o=await setup(t);const a=await(await fetch(o+'/catalog/list?page=1')).text();const b=await(await fetch(o+'/catalog/list?page=2')).text();assert.match(a,/room-102/);assert.match(b,/room-102/);assert.match(a,/href="\?page=2"/);});
test('授权清单变化不改变详情内容 ETag',async t=>{const o=await setup(t);const first=await fetch(o+'/catalog/detail/room-101');const etag=first.headers.get('etag');await first.text();await control(o,{grantVersion:2,fields:['district','area']});const again=await fetch(o+'/catalog/detail/room-101',{headers:{'if-none-match':etag}});assert.equal(again.status,304);const manifest=await(await fetch(o+'/catalog/manifest')).json();assert.equal(manifest.grantVersion,2);assert.deepEqual(manifest.allowedFields,['district','area']);});
test('撤回房源及显式限流保持可观察',async t=>{const o=await setup(t);await control(o,{generation:2,grantVersion:2,revoked:['room-102'],limited:1});assert.equal((await fetch(o+'/catalog/detail/room-101')).status,429);assert.equal((await fetch(o+'/catalog/detail/room-102')).status,404);const m=await(await fetch(o+'/catalog/manifest')).json();assert.deepEqual(m.revoked,['room-102']);});
test('跳转和禁止路径由源站暴露',async t=>{const o=await setup(t);assert.match(await(await fetch(o+'/robots.txt')).text(),/Disallow: \/catalog\/private\//);const r=await fetch(o+'/catalog/redirect',{redirect:'manual'});assert.equal(r.headers.get('location'),'/outside/contact');});
test('代次回退被拒绝',async t=>{const o=await setup(t);await control(o,{generation:3});assert.equal((await control(o,{generation:2})).status,400);});

test('在途详情保留响应开始时的代次',async t=>{
 const source=createSource();const o=await source.listen();t.after(()=>source.close());
 const arrived=new Promise(resolve=>source.server.once('request',resolve));
 const pending=fetch(o+'/catalog/detail/room-101?hold=1');await arrived;
 const held=await(await fetch(o+'/__control/held')).json();assert.equal(held.length,1);
 await control(o,{generation:2,grantVersion:2,revoked:['room-101']});
 await fetch(o+'/__control/release',{method:'POST',body:JSON.stringify({id:held[0]})});
 const response=await pending;assert.equal(response.headers.get('x-data-generation'),'1');assert.match(await response.text(),/room-101/);
 assert.equal((await fetch(o+'/catalog/detail/room-101')).status,404);
});
