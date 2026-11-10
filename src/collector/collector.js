// 采集器编排：多个获准站点共用一套引擎，各自独立的调度器与状态文件。
// 公开入口：runOnce（全站点一轮，自动续传）、runSite、refreshGrants、
// status、records、close。时钟、fetch、随机源、日志均可注入。

import { realClock } from './clock.js';
import { parseRobots, ALLOW_ALL, DENY_ALL } from './robots.js';
import { createHttpClient } from './http.js';
import { SiteScheduler } from './scheduler.js';
import { SiteStore } from './store.js';
import { executeScan } from './scan.js';
import { sanitizeMessage } from './sanitize.js';

const MAX_RESTARTS_PER_RUN = 3;

export function validateSiteConfig(site) {
  if (!/^[\w][\w-]*$/.test(site.key ?? '')) {
    throw new Error('站点 key 只能包含字母、数字、下划线与连字符');
  }
  const origin = new URL(site.origin);
  if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
    throw new Error('origin 必须是 http(s) 地址');
  }
  if (origin.username || origin.password) throw new Error('origin 不得携带凭据');
  if (origin.pathname !== '/' && origin.pathname !== '') throw new Error('origin 只能到主机，路径请用 pathPrefix');
  if (!site.pathPrefix?.startsWith('/')) throw new Error('pathPrefix 必须以 / 开头');
  if (!site.purpose) throw new Error('缺少用途标识 purpose');
  if (!Array.isArray(site.allowedFields) || site.allowedFields.length === 0) {
    throw new Error('allowedFields 必须是非空数组');
  }
  return { ...site, origin: origin.origin };
}

export function createCollector({
  sites,
  stateDir,
  clock = realClock,
  fetchImpl = (url, opts) => fetch(url, opts),
  logger = { log: (event, data) => console.error(JSON.stringify({ event, ...data })) },
  random = Math.random,
}) {
  if (!stateDir) throw new Error('缺少 stateDir');
  const contexts = new Map();
  for (const rawSite of sites) {
    const site = validateSiteConfig(rawSite);
    contexts.set(site.key, {
      site,
      scheduler: new SiteScheduler({
        clock,
        concurrency: site.concurrency ?? 2,
        intervalMs: site.requestIntervalMs ?? 0,
      }),
      store: new SiteStore({ dir: stateDir, site, clock }),
      robots: null,
      http: null,
      running: null,
    });
  }

  function ctxOf(key) {
    const ctx = contexts.get(key);
    if (!ctx) throw new Error(`未知站点：${key}`);
    return ctx;
  }

  async function ensureHttp(ctx) {
    await ctx.store.load();
    if (ctx.http) return;
    ctx.robots = await fetchRobots(ctx);
    ctx.http = createHttpClient({
      site: ctx.site,
      scheduler: ctx.scheduler,
      robots: ctx.robots,
      fetchImpl,
      clock,
      logger,
      random,
    });
  }

  async function fetchRobots(ctx) {
    // robots.txt 是规则来源本身，抓取它不做前缀核对
    const probe = createHttpClient({
      site: ctx.site,
      scheduler: ctx.scheduler,
      robots: ALLOW_ALL,
      fetchImpl,
      clock,
      logger,
      random,
    });
    try {
      const res = await probe.request('/robots.txt', { skipScopeCheck: true });
      if (res.status === 200) return parseRobots(await res.text());
      if (res.status === 404) return ALLOW_ALL;
      return DENY_ALL; // robots 异常时宁可停抓，也不越过可能存在的禁令
    } catch {
      return DENY_ALL;
    }
  }

  async function fetchManifest(ctx) {
    const res = await ctx.http.request('/catalog/manifest');
    if (res.status !== 200) {
      await res.arrayBuffer().catch(() => {});
      throw new Error(`授权清单不可用（状态 ${res.status}）`);
    }
    return res.json();
  }

  async function refreshGrants(key) {
    const keys = key ? [key] : [...contexts.keys()];
    const outcomes = {};
    for (const k of keys) {
      const ctx = ctxOf(k);
      await ensureHttp(ctx);
      const manifest = await fetchManifest(ctx);
      const result = ctx.store.applyManifest(manifest);
      await ctx.store.save();
      if (result.applied) {
        logger.log('grants-confirmed', {
          site: k,
          grantVersion: ctx.store.state.grant.knownGrantVersion,
          revokedCount: ctx.store.state.grant.revokedIds.length,
        });
      }
      outcomes[k] = result;
    }
    return outcomes;
  }

  async function runSite(key) {
    const ctx = ctxOf(key);
    if (ctx.running) return ctx.running;
    ctx.running = (async () => {
      try {
        await ensureHttp(ctx);
        let manifest = await fetchManifest(ctx);
        if (manifest.purpose !== ctx.site.purpose) {
          throw new Error(`用途不一致：配置为 ${ctx.site.purpose}，清单为 ${manifest.purpose}`);
        }
        ctx.store.applyManifest(manifest);
        await ctx.store.save();
        for (let restart = 0; restart < MAX_RESTARTS_PER_RUN; restart++) {
          const result = await executeScan({
            site: ctx.site,
            store: ctx.store,
            http: ctx.http,
            logger,
            clock,
            manifest,
            refreshManifest: async () => {
              const fresh = await fetchManifest(ctx);
              ctx.store.applyManifest(fresh);
              await ctx.store.save();
              return fresh;
            },
          });
          if (result === 'generation-changed' || result === 'aborted') {
            // 站点中途切换了代次：以新清单为边界重新开始，旧轮不做任何下架判定
            manifest = await fetchManifest(ctx);
            ctx.store.applyManifest(manifest);
            await ctx.store.save();
            continue;
          }
          return result;
        }
        return 'incomplete';
      } catch (err) {
        const reason = sanitizeMessage(err.message ?? err);
        try {
          ctx.store.state.lastResult = { type: 'failed', reason, at: clock.nowISO() };
          await ctx.store.save();
        } catch { /* 状态落盘失败不再掩盖原始错误 */ }
        logger.log('site-failed', { site: key, reason });
        return 'failed';
      } finally {
        ctx.running = null;
      }
    })();
    return ctx.running;
  }

  async function runOnce() {
    const results = {};
    await Promise.all(
      [...contexts.keys()].map(async key => {
        results[key] = await runSite(key);
      }),
    );
    return results;
  }

  async function status(key) {
    if (key) {
      const ctx = ctxOf(key);
      await ctx.store.load();
      return ctx.store.status();
    }
    const out = {};
    for (const k of contexts.keys()) out[k] = await status(k);
    return out;
  }

  async function records(key) {
    const ctx = ctxOf(key);
    await ctx.store.load();
    return Object.values(ctx.store.state.dataset.records).map(r => structuredClone(r));
  }

  async function close() {
    for (const ctx of contexts.values()) {
      if (ctx.store.state) await ctx.store.flush();
    }
  }

  return { runOnce, runSite, refreshGrants, status, records, close };
}
