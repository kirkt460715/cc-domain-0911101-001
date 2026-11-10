// 值班操作入口：启动 / 恢复 / 状态查询。
//
//   node src/collector/cli.js start  --config <file> [--state <dir>]
//   node src/collector/cli.js resume --config <file> [--state <dir>]
//   node src/collector/cli.js status [--config <file>] [--state <dir>]
//
// start 与 resume 共用同一引擎：扫描游标持久化在状态目录里，
// 限流、网络中断、进程退出后直接再跑一遍即可从断点继续。
// status 只读状态目录，不需要配置文件，输出不含任何页面内容或联系方式。

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createCollector } from './index.js';

const [command, ...rest] = process.argv.slice(2);

function arg(name) {
  const i = rest.indexOf('--' + name);
  return i >= 0 ? rest[i + 1] : undefined;
}

function printStatus(summary) {
  console.log(`站点 ${summary.site}（用途 ${summary.purpose}）`);
  console.log(`  已确认授权版本: ${summary.knownGrantVersion}  允许字段: ${summary.allowedFields.join(', ') || '(无)'}`);
  console.log(`  撤回编号: ${summary.revokedIds.length ? summary.revokedIds.join(', ') : '(无)'}`);
  console.log(`  完整视图代次: ${summary.completeGeneration}  当前记录数: ${summary.recordCount}`);
  if (summary.scan) {
    const s = summary.scan;
    console.log(
      `  进行中扫描: 代次 ${s.generation}，分页完成 ${s.pagesDone}、排队 ${s.pagesQueued}，` +
        `详情完成 ${s.detailsDone}、待抓 ${s.detailsPending}、失败 ${s.detailsFailed.length}`,
    );
    for (const f of s.detailsFailed) console.log(`    缺口: ${f.id}（${f.reason}，${f.attempts} 次）`);
  } else {
    console.log('  进行中扫描: 无');
  }
  if (summary.lastResult) console.log(`  最近结果: ${JSON.stringify(summary.lastResult)}`);
}

async function loadConfig() {
  const configPath = arg('config');
  if (!configPath) throw new Error('缺少 --config <file>');
  return JSON.parse(await readFile(configPath, 'utf8'));
}

if (command === 'start' || command === 'resume') {
  const config = await loadConfig();
  const stateDir = arg('state') ?? config.stateDir;
  if (!stateDir) throw new Error('缺少状态目录（--state 或配置中的 stateDir）');
  const collector = createCollector({ sites: config.sites, stateDir });
  const results = await collector.runOnce();
  await collector.close();
  let ok = true;
  for (const [key, result] of Object.entries(results)) {
    console.log(`站点 ${key}: ${result}`);
    if (result !== 'complete') ok = false;
  }
  for (const key of Object.keys(results)) printStatus(await collector.status(key));
  process.exit(ok ? 0 : 1);
} else if (command === 'status') {
  const stateDir = arg('state');
  if (!stateDir) throw new Error('缺少 --state <dir>');
  const files = (await readdir(stateDir)).filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
  if (files.length === 0) {
    console.log('状态目录中没有站点状态。');
    process.exit(0);
  }
  for (const file of files.sort()) {
    const state = JSON.parse(await readFile(join(stateDir, file), 'utf8'));
    printStatus({
      site: state.siteKey,
      purpose: '(见配置)',
      knownGrantVersion: state.grant.knownGrantVersion,
      revokedIds: state.grant.revokedIds,
      allowedFields: state.grant.allowedFields,
      completeGeneration: state.dataset.completeGeneration,
      recordCount: Object.keys(state.dataset.records).length,
      scan: state.scan
        ? {
            generation: state.scan.generation,
            pagesDone: state.scan.pages.done.length,
            pagesQueued: state.scan.pages.queue.length,
            detailsDone: state.scan.details.done.length,
            detailsPending: state.scan.details.pending.length,
            detailsFailed: state.scan.details.failed,
          }
        : null,
      lastResult: state.lastResult,
    });
  }
} else {
  console.error('用法：node src/collector/cli.js start|resume --config <file> [--state <dir>]');
  console.error('      node src/collector/cli.js status --state <dir>');
  process.exit(2);
}
