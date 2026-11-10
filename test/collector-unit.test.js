import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseRobots,
  ALLOW_ALL,
  createHttpClient,
  SiteScheduler,
  SiteStore,
  ManualClock,
  normalizePath,
  sanitizeMessage,
  sanitizeUrlForLog,
  parseListPage,
  parseDetailPage,
} from '../src/collector/index.js';

const noopLogger = { log: () => {} };

test('robots：通配分组的前缀规则，最长匹配优先', () => {
  const robots = parseRobots('User-agent: *\nAllow: /catalog/\nDisallow: /catalog/private/\nDisallow: /outside/\n');
  assert.equal(robots.allows('/catalog/list'), true);
  assert.equal(robots.allows('/catalog/private/contact'), false);
  assert.equal(robots.allows('/outside/contact'), false);
  assert.equal(robots.allows('/other'), true);
});

test('地址清洗：持久化键只留 page 参数，日志只留路径', () => {
  assert.equal(normalizePath('/catalog/list?page=2&token=SECRET'), '/catalog/list?page=2');
  assert.equal(normalizePath('/catalog/detail/room-1?hold=1', { keepPage: false }), '/catalog/detail/room-1');
  assert.equal(sanitizeUrlForLog('http://a.test/x/y?token=SECRET'), '/x/y');
  assert.equal(sanitizeMessage('失败 http://a.test/x?token=SECRET 重试'), '失败 /x 重试');
});

test('解析：相对链接、同页重复链接去重、字段提取', () => {
  const list = parseListPage(
    '<main><a data-listing-id="room-1" href="/catalog/detail/room-1">东园</a>' +
      '<a data-listing-id="room-1" href="/catalog/detail/room-1">重复</a>' +
      '<a rel="next" href="?page=2">下一页</a>' +
      '<a href="/catalog/private/contact">内部页面</a></main>',
  );
  assert.deepEqual(list.details, [{ id: 'room-1', href: '/catalog/detail/room-1' }]);
  assert.equal(list.next, '?page=2');
  const detail = parseDetailPage(
    '<article data-listing-id="room-1" data-version="3" data-generation="2">' +
      '<span data-field="district">东园</span><span data-field="area">68</span>' +
      '<span data-field="contactName">合成人物</span></article>',
  );
  assert.equal(detail.id, 'room-1');
  assert.equal(detail.version, 3);
  assert.equal(detail.fields.area, 68);
});

test('范围核对：同域名不同路径不算获准，跨 origin 拒绝', async () => {
  const clock = new ManualClock();
  const site = { key: 't', origin: 'http://a.test', pathPrefix: '/catalog/' };
  let calls = 0;
  const http = createHttpClient({
    site,
    scheduler: new SiteScheduler({ clock }),
    robots: parseRobots('User-agent: *\nAllow: /catalog/\nDisallow: /catalog/private/\nDisallow: /outside/\n'),
    fetchImpl: async () => {
      calls++;
      return new Response('ok');
    },
    clock,
    logger: noopLogger,
    random: () => 0,
  });
  assert.equal(http.checkScope('/catalog/list'), null);
  assert.equal(http.checkScope('/other/list'), 'path-prefix');
  assert.equal(http.checkScope('http://b.test/catalog/list'), 'cross-origin');
  assert.equal(http.checkScope('/outside/contact'), 'path-prefix'); // 前缀与 robots 双重禁止，前缀先命中
  assert.equal(http.checkScope('/catalog/private/contact'), 'robots');
  await assert.rejects(() => http.request('/catalog/private/contact'), e => e.code === 'out-of-scope');
  assert.equal(calls, 0); // 被禁止的链接没有发请求
});

test('跳转逐跳核对：越范围的下一跳不会被请求', async () => {
  const clock = new ManualClock();
  const site = { key: 't', origin: 'http://a.test', pathPrefix: '/catalog/' };
  const seen = [];
  const http = createHttpClient({
    site,
    scheduler: new SiteScheduler({ clock }),
    robots: ALLOW_ALL,
    fetchImpl: async url => {
      seen.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://b.test/catalog/list' } });
    },
    clock,
    logger: noopLogger,
    random: () => 0,
  });
  await assert.rejects(() => http.request('/catalog/redirect'), e => e.code === 'out-of-scope' && e.reason === 'cross-origin');
  assert.deepEqual(seen, ['http://a.test/catalog/redirect']); // 只请求了第一跳
});

test('重试预算：限流按次数耗尽，等待走可替换时钟', async () => {
  const clock = new ManualClock();
  const site = { key: 't', origin: 'http://a.test', pathPrefix: '/catalog/', maxAttempts: 3, baseBackoffMs: 10 };
  let calls = 0;
  const http = createHttpClient({
    site,
    scheduler: new SiteScheduler({ clock }),
    robots: ALLOW_ALL,
    fetchImpl: async () => {
      calls++;
      return new Response('限流', { status: 429, headers: { 'retry-after': '2' } });
    },
    clock,
    logger: noopLogger,
    random: () => 0,
  });
  await assert.rejects(
    () => http.request('/catalog/list?page=1'),
    e => e.code === 'retry-exhausted' && e.reason === 'rate-limited' && e.attempts === 3,
  );
  assert.equal(calls, 3);
  assert.ok(clock.now() >= 4000); // 两次 Retry-After 冷却已按注入时钟推进
});

test('重试预算：时间预算先于次数耗尽', async () => {
  const clock = new ManualClock();
  const site = { key: 't', origin: 'http://a.test', pathPrefix: '/catalog/', maxAttempts: 10, retryBudgetMs: 3000, baseBackoffMs: 10 };
  let calls = 0;
  const http = createHttpClient({
    site,
    scheduler: new SiteScheduler({ clock }),
    robots: ALLOW_ALL,
    fetchImpl: async () => {
      calls++;
      return new Response('限流', { status: 429, headers: { 'retry-after': '2' } });
    },
    clock,
    logger: noopLogger,
    random: () => 0,
  });
  await assert.rejects(() => http.request('/catalog/list'), e => e.code === 'retry-exhausted');
  assert.ok(calls < 10);
});

async function makeStore(t, fields = ['district', 'area', 'rent']) {
  const dir = await mkdtemp(join(tmpdir(), 'store-unit-'));
  const clock = new ManualClock();
  const store = new SiteStore({ dir, site: { key: 's', allowedFields: fields }, clock });
  await store.load();
  return { store, clock, dir };
}

test('存储门控：撤回、旧代次、旧版本都无权写入', async () => {
  const { store } = await makeStore(test);
  store.applyManifest({ grantVersion: 1, allowedFields: ['district', 'area', 'rent'], revoked: [], generation: 1 });
  store.startScan(1, 1);
  assert.equal(store.commitDetail({ id: 'a', version: 2, generation: 1, fields: { district: '东' } }), 'committed');
  assert.equal(store.commitDetail({ id: 'a', version: 1, generation: 1, fields: { district: '西' } }), 'dropped:older-version');
  assert.equal(store.commitDetail({ id: 'b', version: 1, generation: 9, fields: {} }), 'dropped:stale-generation');
  store.applyManifest({ grantVersion: 2, allowedFields: ['district', 'area', 'rent'], revoked: ['a'], generation: 1 });
  assert.equal(store.commitDetail({ id: 'a', version: 3, generation: 1, fields: {} }), 'dropped:revoked');
  assert.equal(store.state.dataset.records.a, undefined); // 撤回即删除
});

test('存储：重放的旧清单不能扩大授权', async () => {
  const { store } = await makeStore(test);
  store.applyManifest({ grantVersion: 2, allowedFields: ['district'], revoked: ['a'], generation: 1 });
  const replay = store.applyManifest({ grantVersion: 1, allowedFields: ['district', 'area', 'rent'], revoked: [], generation: 1 });
  assert.equal(replay.applied, false);
  assert.deepEqual(store.state.grant.revokedIds, ['a']);
  assert.deepEqual(store.state.grant.allowedFields, ['district']);
});

test('存储：字段收窄清理记录、缓存与恢复材料', async () => {
  const { store, dir } = await makeStore(test);
  store.applyManifest({ grantVersion: 1, allowedFields: ['district', 'area', 'rent'], revoked: [], generation: 1 });
  store.startScan(1, 1);
  store.commitDetail({ id: 'a', version: 1, generation: 1, fields: { district: '东', area: 68, rent: 3200 }, etag: '"e"', path: '/catalog/detail/a' });
  store.state.scan.details.pending.push('a');
  store.applyManifest({ grantVersion: 2, allowedFields: ['district'], revoked: [], generation: 1 });
  assert.deepEqual(store.state.dataset.records.a.fields, { district: '东' });
  await store.save();
  const saved = await readFile(join(dir, 's.json'), 'utf8');
  assert.ok(!saved.includes('"rent"'));
  assert.ok(!saved.includes('3200'));
});

test('存储：撤回编号从扫描游标与缓存中清除', async () => {
  const { store } = await makeStore(test);
  store.applyManifest({ grantVersion: 1, allowedFields: ['district'], revoked: [], generation: 1 });
  const scan = store.startScan(1, 1);
  scan.details.pending.push('a', 'b');
  scan.details.paths.a = '/catalog/detail/a';
  store.state.cache.details.a = { etag: '"e"', path: '/catalog/detail/a' };
  store.applyManifest({ grantVersion: 2, allowedFields: ['district'], revoked: ['a'], generation: 1 });
  assert.deepEqual(store.state.scan.details.pending, ['b']);
  assert.equal(store.state.cache.details.a, undefined);
});

test('存储：finalize 只保留本轮确认过的记录', async () => {
  const { store } = await makeStore(test);
  store.applyManifest({ grantVersion: 1, allowedFields: ['district'], revoked: [], generation: 1 });
  store.startScan(1, 1);
  store.commitDetail({ id: 'a', version: 1, generation: 1, fields: { district: '东' } });
  store.finalizeScan();
  store.startScan(2, 1);
  store.commitDetail({ id: 'b', version: 1, generation: 2, fields: { district: '西' } });
  store.finalizeScan();
  assert.deepEqual(Object.keys(store.state.dataset.records), ['b']);
  assert.equal(store.state.dataset.completeGeneration, 2);
});
