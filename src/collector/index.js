// 可导入的采集接口。
//
// 典型用法：
//   import { createCollector } from './src/collector/index.js';
//   const collector = createCollector({
//     sites: [{ key, origin, pathPrefix, purpose, allowedFields, ... }],
//     stateDir: './.collector-state',
//   });
//   await collector.runOnce();          // 启动/续传一轮完整扫描
//   await collector.refreshGrants();    // 立即确认最新授权清单（撤回先生效）
//   const view = await collector.records('site-key');
//   const st = await collector.status();

export { createCollector, validateSiteConfig } from './collector.js';
export { SiteScheduler } from './scheduler.js';
export { createHttpClient, GapError, BlockedError } from './http.js';
export { parseRobots, ALLOW_ALL, DENY_ALL } from './robots.js';
export { realClock, ManualClock } from './clock.js';
export { SiteStore } from './store.js';
export { normalizePath, sanitizeUrlForLog, sanitizeMessage, pickAllowed } from './sanitize.js';
export { parseListPage, parseDetailPage } from './parse.js';
