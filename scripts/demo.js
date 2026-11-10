// 端到端演示：真实本地 HTTP 往返。
//   场景一：一次完整同步
//   场景二：进程中途退出（SIGKILL）后的断点接续
//   场景三：撤回确认后，滞留的旧响应不能把记录写回来
// 运行：npm run demo

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createSource } from '../src/source.js';
import { createCollector } from '../src/collector/index.js';

const cliPath = new URL('../src/collector/cli.js', import.meta.url).pathname;

const control = (origin, data) =>
  fetch(origin + '/__control/state', { method: 'POST', body: JSON.stringify(data) }).then(r => r.json());
const requestsOf = origin => fetch(origin + '/__control/requests').then(r => r.json());

function section(title) {
  console.log('\n=== ' + title + ' ===');
}

async function waitFor(fn, { timeout = 15_000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeout) throw new Error('等待超时');
    await new Promise(r => setTimeout(r, interval));
  }
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (err += d));
    child.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(`cli 退出码 ${code}\n${out}\n${err}`))));
  });
}

const source = createSource();
const origin = await source.listen();
const stateDir = await mkdtemp(join(tmpdir(), 'collector-demo-'));
const quietLogger = { log: () => {} };
const site = {
  key: 'site-a',
  origin,
  pathPrefix: '/catalog/',
  purpose: 'rental-index',
  allowedFields: ['district', 'area', 'rent'],
};

console.log(`源站: ${origin}`);
console.log(`状态目录: ${stateDir}`);

// —— 场景一：完整同步 ——
section('场景一：完整同步');
const collector = createCollector({ sites: [site], stateDir, logger: quietLogger });
console.log('runOnce:', await collector.runOnce());
for (const record of await collector.records('site-a')) {
  console.log(`  ${record.id} v${record.version} 代次${record.generation} 授权v${record.grantVersion}`, record.fields);
}
console.log('状态:', JSON.stringify(await collector.status('site-a')));

// —— 场景二：进程中途退出后的接续 ——
section('场景二：进程被 SIGKILL 后的断点接续');
// 源站推进到代次 2，并把 room-103 更新为新版本，验证增量更新
const listings = JSON.parse(await readFile(new URL('../fixtures/listings.json', import.meta.url), 'utf8'));
listings.find(x => x.id === 'room-103').version = 2;
listings.find(x => x.id === 'room-103').rent = 4500;
await control(origin, { generation: 2, listings });

// 用一个独立配置文件启动子进程，请求间隔拉大，方便在中途杀掉
const configPath = join(stateDir, 'collector.config.json');
await writeFile(
  configPath,
  JSON.stringify({ stateDir, sites: [{ ...site, requestIntervalMs: 400 }] }),
);
const child = spawn(process.execPath, [cliPath, 'start', '--config', configPath], { stdio: 'ignore' });
await waitFor(async () => {
  try {
    const state = JSON.parse(await readFile(join(stateDir, 'site-a.json'), 'utf8'));
    return state.scan && state.scan.details.done.length >= 1;
  } catch {
    return false;
  }
});
child.kill('SIGKILL');
await new Promise(resolve => child.on('exit', resolve));
const atKill = (await requestsOf(origin)).length;
const midState = JSON.parse(await readFile(join(stateDir, 'site-a.json'), 'utf8'));
console.log(`被终止时：扫描代次 ${midState.scan.generation}，已完成详情 ${midState.scan.details.done.join(', ')}，待抓 ${midState.scan.details.pending.join(', ')}`);

console.log('以 resume 接续……');
console.log(await runCli(['resume', '--config', configPath]));
const after = await requestsOf(origin);
const resumedDetailFetches = after.slice(atKill).filter(r => r.path.startsWith('/catalog/detail/'));
const refetched = resumedDetailFetches.filter(r => midState.scan.details.done.some(id => r.path.endsWith('/' + id)));
console.log(`接续期间详情请求 ${resumedDetailFetches.length} 次，其中重复抓取已确认详情 ${refetched.length} 次`);
// 子进程在状态目录上留下了新状态，用新实例读取（旧实例持有的是内存快照）
const checker = createCollector({ sites: [site], stateDir, logger: quietLogger });
for (const record of await checker.records('site-a')) {
  console.log(`  ${record.id} v${record.version} 代次${record.generation} 授权v${record.grantVersion}`, record.fields);
}

// —— 场景三：撤回确认后，滞留旧响应不得复活记录 ——
section('场景三：撤回生效期间，滞留的旧响应被丢弃');
// 让 room-101 的详情请求在源站挂起（模拟合作方收回时已排进队列/在途的旧任务）
const holdingFetch = (url, opts) =>
  url.startsWith(origin + '/catalog/detail/room-101') ? fetch(url + '?hold=1', opts) : fetch(url, opts);
const collector2 = createCollector({ sites: [site], stateDir, logger: quietLogger, fetchImpl: holdingFetch });
const running = collector2.runOnce();
await waitFor(async () => (await fetch(origin + '/__control/held').then(r => r.json())).length === 1);
console.log('room-101 的详情响应已在源站挂起（在途旧任务）');

await control(origin, { generation: 3, grantVersion: 2, revoked: ['room-101'] });
await collector2.refreshGrants();
console.log('已确认授权 v2（撤回 room-101）。撤回即刻生效，无需等待完整扫描：');
console.log('  当前视图中的编号:', (await collector2.records('site-a')).map(r => r.id).join(', '));

const held = await fetch(origin + '/__control/held').then(r => r.json());
await fetch(origin + '/__control/release', { method: 'POST', body: JSON.stringify({ id: held[0] }) });
console.log('滞留响应已返回（旧代次内容），runOnce 结果:', await running);
console.log('  最终视图中的编号:', (await collector2.records('site-a')).map(r => r.id).join(', '));
console.log('  room-101 是否复活:', (await collector2.records('site-a')).some(r => r.id === 'room-101'));

await source.close();
console.log('\n演示完成。');
