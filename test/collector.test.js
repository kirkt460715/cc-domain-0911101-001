import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createSource } from '../src/source.js';
import { createCollector, parseRobots, createHttpClient, SiteScheduler, realClock } from '../src/collector/index.js';

const cliPath = new URL('../src/collector/cli.js', import.meta.url).pathname;

function memoryLogger() {
  const events = [];
  return { events, log: (event, data) => events.push({ event, ...structuredClone(data ?? {}) }) };
}

async function waitFor(fn, { timeout = 10_000, interval = 25 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, interval));
  }
}

async function setup(t, siteOverrides = {}) {
  const source = createSource();
  const origin = await source.listen();
  t.after(() => source.close());
  const stateDir = await mkdtemp(join(tmpdir(), 'collector-it-'));
  const logger = memoryLogger();
  const site = {
    key: 'a',
    origin,
    pathPrefix: '/catalog/',
    purpose: 'rental-index',
    allowedFields: ['district', 'area', 'rent'],
    ...siteOverrides,
  };
  return { source, origin, stateDir, logger, site };
}

const control = (origin, data) =>
  fetch(origin + '/__control/state', { method: 'POST', body: JSON.stringify(data) });
const requestsOf = origin => fetch(origin + '/__control/requests').then(r => r.json());
const make = (sites, stateDir, extra = {}) =>
  createCollector({ sites, stateDir, logger: memoryLogger(), ...extra });

test('完整同步：记录只含允许字段与授权依据，禁止路径从不请求', async t => {
  const { origin, stateDir, site } = await setup(t);
  const collector = make([site], stateDir);
  assert.deepEqual(await collector.runOnce(), { a: 'complete' });

  const records = await collector.records('a');
  assert.equal(records.length, 3);
  for (const record of records) {
    assert.deepEqual(Object.keys(record.fields).sort(), ['area', 'district', 'rent']);
    assert.equal(record.grantVersion, 1);
    assert.ok(record.fetchedAt);
  }
  assert.equal((await collector.status('a')).completeGeneration, 1);

  // 增量第二轮：详情走条件请求拿到 304，记录不变
  assert.deepEqual(await collector.runOnce(), { a: 'complete' });
  const reqs = await requestsOf(origin);
  assert.equal(reqs.filter(r => r.path.startsWith('/catalog/detail/')).length, 6);
  assert.equal((await collector.records('a')).length, 3);

  // robots 禁止与范围外链接从未被请求
  assert.ok(!reqs.some(r => r.path.startsWith('/catalog/private')));
  assert.ok(!reqs.some(r => r.path.startsWith('/outside')));
});

test('跨范围跳转：下一跳先核对，目标不会被请求', async t => {
  const { origin, site } = await setup(t);
  const other = createSource();
  const otherOrigin = await other.listen();
  t.after(() => other.close());

  const robots = parseRobots(await (await fetch(origin + '/robots.txt')).text());
  const http = createHttpClient({
    site,
    scheduler: new SiteScheduler({ clock: realClock }),
    robots,
    fetchImpl: (u, o) => fetch(u, o),
    clock: realClock,
    logger: memoryLogger(),
    random: () => 0,
  });
  // 默认跳转 /outside/contact：被 robots 与前缀双重禁止
  await assert.rejects(() => http.request('/catalog/redirect'), e => e.code === 'out-of-scope');
  // 指向另一个本地站点的跳转：跨 origin 同样终止
  await control(origin, { redirectTo: otherOrigin + '/catalog/list?page=1' });
  await assert.rejects(() => http.request('/catalog/redirect'), e => e.reason === 'cross-origin');
  assert.equal((await requestsOf(otherOrigin)).length, 0);
  const reqs = await requestsOf(origin);
  assert.ok(!reqs.some(r => r.path === '/outside/contact'));
});

test('部分遍历与中断恢复：不误删、不重抓已确认数据', async t => {
  const { origin, stateDir, site } = await setup(t);
  const c1 = make([site], stateDir);
  assert.deepEqual(await c1.runOnce(), { a: 'complete' });

  // 第二轮：room-103 的详情请求全部网络失败（预算一次即耗尽）
  await control(origin, { generation: 2 });
  const flaky = (url, opts) =>
    url.includes('/catalog/detail/room-103') ? Promise.reject(new Error('连接中断')) : fetch(url, opts);
  const c2 = createCollector({
    sites: [{ ...site, maxAttempts: 1 }],
    stateDir,
    logger: memoryLogger(),
    fetchImpl: flaky,
  });
  assert.equal((await c2.runOnce()).a, 'incomplete');
  // 部分遍历不得判定下架：三条记录都还在
  assert.equal((await c2.records('a')).length, 3);
  const status = await c2.status('a');
  assert.equal(status.lastResult.type, 'incomplete');
  assert.deepEqual(status.lastResult.gaps.details.map(d => d.id), ['room-103']);

  // 恢复：新实例从持久化游标继续，只补抓缺口
  const c3 = make([site], stateDir);
  assert.equal((await c3.runOnce()).a, 'complete');
  assert.equal((await c3.status('a')).completeGeneration, 2);
  const reqs = await requestsOf(origin);
  // room-101/102 在第二轮已确认（304），第三轮没有重复请求；
  // room-103 第二轮的失败在客户端发生（未发请求），第三轮补抓一次成功
  assert.equal(reqs.filter(r => r.path === '/catalog/detail/room-101').length, 2);
  assert.equal(reqs.filter(r => r.path === '/catalog/detail/room-102').length, 2);
  assert.equal(reqs.filter(r => r.path === '/catalog/detail/room-103').length, 2);
});

test('进程退出后从持久化进度继续（SIGKILL + CLI resume）', async t => {
  const { origin, stateDir, site } = await setup(t);
  const { writeFile } = await import('node:fs/promises');
  const configPath = join(stateDir, 'config.json');
  await writeFile(configPath, JSON.stringify({ stateDir, sites: [{ ...site, requestIntervalMs: 300 }] }));

  const child = spawn(process.execPath, [cliPath, 'start', '--config', configPath], { stdio: 'ignore' });
  await waitFor(async () => {
    try {
      const state = JSON.parse(await readFile(join(stateDir, 'a.json'), 'utf8'));
      return state.scan && state.scan.details.done.length >= 1;
    } catch {
      return false;
    }
  });
  child.kill('SIGKILL');
  await new Promise(resolve => child.on('exit', resolve));

  const mid = JSON.parse(await readFile(join(stateDir, 'a.json'), 'utf8'));
  assert.ok(mid.scan.details.done.length >= 1);
  assert.equal(mid.dataset.completeGeneration, 0);

  const resumed = spawn(process.execPath, [cliPath, 'resume', '--config', configPath], { stdio: 'ignore' });
  const exitCode = await new Promise(resolve => resumed.on('exit', resolve));
  assert.equal(exitCode, 0);
  const final = JSON.parse(await readFile(join(stateDir, 'a.json'), 'utf8'));
  assert.equal(final.dataset.completeGeneration, 1);
  assert.equal(Object.keys(final.dataset.records).length, 3);
  // 被终止前已确认的详情没有被重新抓取
  const reqs = await requestsOf(origin);
  for (const id of mid.scan.details.done) {
    assert.equal(reqs.filter(r => r.path === '/catalog/detail/' + id).length, 1, `${id} 被重复抓取`);
  }
});

test('撤回先于后续提交生效，滞留旧响应不得复活记录', async t => {
  const { origin, stateDir, site } = await setup(t);
  const c1 = make([site], stateDir);
  assert.equal((await c1.runOnce()).a, 'complete');
  assert.ok((await c1.records('a')).some(r => r.id === 'room-101'));

  // room-101 的详情请求在源站挂起：模拟收回时已排进队列的在途旧任务
  const holding = (url, opts) =>
    url.startsWith(origin + '/catalog/detail/room-101') ? fetch(url + '?hold=1', opts) : fetch(url, opts);
  const c2 = createCollector({ sites: [site], stateDir, logger: memoryLogger(), fetchImpl: holding });
  const running = c2.runOnce();
  await waitFor(async () => (await (await fetch(origin + '/__control/held')).json()).length === 1);

  // 合作方收回 room-101：代次与授权版本同时推进
  await control(origin, { generation: 2, grantVersion: 2, revoked: ['room-101'] });
  await c2.refreshGrants();
  // 撤回在可查询视图中立即生效，即使完整扫描尚未结束
  assert.ok(!(await c2.records('a')).some(r => r.id === 'room-101'));
  assert.deepEqual((await c2.status('a')).revokedIds, ['room-101']);

  // 滞留的旧响应返回：无权写入，记录不得复活
  const held = await (await fetch(origin + '/__control/held')).json();
  await fetch(origin + '/__control/release', { method: 'POST', body: JSON.stringify({ id: held[0] }) });
  assert.equal((await running).a, 'complete');
  const records = await c2.records('a');
  assert.ok(!records.some(r => r.id === 'room-101'));
  assert.equal(records.length, 2);
  assert.equal((await c2.status('a')).completeGeneration, 2);
});

test('重新开放后可以再次采集', async t => {
  const { origin, stateDir, site } = await setup(t);
  const collector = make([site], stateDir);
  await collector.runOnce();
  await control(origin, { generation: 2, grantVersion: 2, revoked: ['room-102'] });
  await collector.refreshGrants();
  assert.equal((await collector.records('a')).length, 2);
  // 以更高授权版本重新公布
  await control(origin, { generation: 3, grantVersion: 3, revoked: [] });
  assert.equal((await collector.runOnce()).a, 'complete');
  const records = await collector.records('a');
  assert.equal(records.length, 3);
  assert.ok(records.find(r => r.id === 'room-102'));
});

test('字段收窄清理现存记录与持久化材料', async t => {
  const { origin, stateDir, site } = await setup(t);
  const collector = make([site], stateDir);
  await collector.runOnce();
  await control(origin, { grantVersion: 2, fields: ['district', 'area'] });
  await collector.refreshGrants();
  for (const record of await collector.records('a')) {
    assert.deepEqual(Object.keys(record.fields).sort(), ['area', 'district']);
  }
  // 再跑一轮（详情 304）：ETag 不能证明权限，字段不会被带回来
  await collector.runOnce();
  const raw = await readFile(join(stateDir, 'a.json'), 'utf8');
  assert.ok(!raw.includes('"rent"'));
  assert.ok(!raw.includes('3200'));
});

test('两个站点互不阻塞：一个冷却时另一个照常完成', async t => {
  const sourceA = createSource();
  const originA = await sourceA.listen();
  const sourceB = createSource();
  const originB = await sourceB.listen();
  t.after(() => sourceA.close());
  t.after(() => sourceB.close());
  const stateDir = await mkdtemp(join(tmpdir(), 'collector-it-'));
  const base = { pathPrefix: '/catalog/', purpose: 'rental-index', allowedFields: ['district', 'area', 'rent'] };
  const collector = make(
    [
      { key: 'a', origin: originA, ...base },
      { key: 'b', origin: originB, ...base },
    ],
    stateDir,
  );
  await control(originA, { limited: 1 }); // A 的第一个业务请求会被 429，Retry-After: 2
  const started = Date.now();
  const all = collector.runOnce();
  await waitFor(async () => (await collector.status('b')).completeGeneration === 1);
  const bDoneAt = Date.now();
  assert.ok(bDoneAt - started < 1500, '站点 B 被站点 A 的限流拖慢');
  assert.equal((await collector.status('a')).completeGeneration, 0, '站点 A 应仍在冷却/重试');
  assert.deepEqual(await all, { a: 'complete', b: 'complete' });
});

test('循环导航不会造成死循环', async t => {
  const { origin, stateDir, site } = await setup(t);
  await control(origin, { repeatPage: true }); // 末页导航回到第一页
  const collector = make([site], stateDir);
  assert.equal((await collector.runOnce()).a, 'complete');
  assert.equal((await collector.records('a')).length, 3);
  const reqs = await requestsOf(origin);
  assert.equal(reqs.filter(r => r.path === '/catalog/list').length, 2); // 每页只抓一次
});

test('限流预算耗尽后保留可解释的缺口，恢复后完成', async t => {
  const { origin, stateDir, site } = await setup(t);
  const c1 = make([site], stateDir);
  assert.equal((await c1.runOnce()).a, 'complete');

  await control(origin, { generation: 2, limited: 2 }); // 接下来的业务请求全部 429
  const c2 = make(
    [{ ...site, maxAttempts: 2, maxCoolingMs: 5, baseBackoffMs: 1 }],
    stateDir,
  );
  assert.equal((await c2.runOnce()).a, 'incomplete');
  const status = await c2.status('a');
  assert.equal(status.lastResult.type, 'incomplete');
  assert.deepEqual(status.lastResult.gaps.pages, [
    { page: '/catalog/list', reason: 'rate-limited', attempts: 2 },
  ]);
  assert.equal((await c2.records('a')).length, 3); // 部分遍历不得误删

  const c3 = make([site], stateDir); // 限流次数已耗尽，恢复后完成
  assert.equal((await c3.runOnce()).a, 'complete');
  assert.equal((await c3.status('a')).completeGeneration, 2);
});

test('输出材料不泄露样本中的敏感值', async t => {
  const { origin, stateDir, site } = await setup(t);
  const logger = memoryLogger();
  // 注入一条带敏感参数的失败，验证异常与日志同样干净
  const fetchImpl = (url, opts) =>
    url.includes('/catalog/detail/room-102')
      ? Promise.reject(new Error('fetch failed http://internal/x?token=SECRET-TOKEN'))
      : fetch(url, opts);
  const collector = createCollector({
    sites: [{ ...site, maxAttempts: 1 }],
    stateDir,
    logger,
    fetchImpl,
  });
  await collector.runOnce();
  const forbidden = ['SYNTHETIC-PHONE', '合成人物', 'contactName', 'contactPhone', 'SECRET-TOKEN', 'hold='];
  for (const file of await readdir(stateDir)) {
    const content = await readFile(join(stateDir, file), 'utf8');
    for (const needle of forbidden) assert.ok(!content.includes(needle), `${file} 泄露了 ${needle}`);
  }
  const logText = JSON.stringify(logger.events);
  for (const needle of forbidden) assert.ok(!logText.includes(needle), `日志泄露了 ${needle}`);
});
