// 范围受控的 HTTP 客户端。
//
// 每一次请求前都核对：origin 必须与接入配置完全一致、路径必须落在获准前缀内、
// robots.txt 必须放行——三者取交集，最严格的一侧生效。域名相同不代表路径已获准。
// 跳转（3xx）不自动跟随：解析下一跳后重新走同一套核对，跨 origin、越前缀、
// 被 robots 禁止或指向登录/联系页等未授权目标的跳转链就此终止，目标不会被请求。
//
// 429 按 Retry-After 让本站点冷却（不波及其他站点）；网络错误与限流共用
// 次数与时间两份预算，耗尽后抛出 GapError，由扫描层记录成可解释的缺口。
// 日志与异常文本只含清洗后的路径，不含查询参数与响应内容。

import { sanitizeUrlForLog } from './sanitize.js';

export class GapError extends Error {
  constructor(reason, attempts, elapsedMs) {
    super(`请求预算耗尽（${reason}），已尝试 ${attempts} 次，用时 ${elapsedMs}ms`);
    this.code = 'retry-exhausted';
    this.reason = reason;
    this.attempts = attempts;
  }
}

export class BlockedError extends Error {
  constructor(reason) {
    super(`目标超出获准范围（${reason}）`);
    this.code = 'out-of-scope';
    this.reason = reason;
  }
}

const MAX_REDIRECTS = 5;

export function createHttpClient({ site, scheduler, robots, fetchImpl, clock, logger, random }) {
  const maxAttempts = site.maxAttempts ?? 5;
  const retryBudgetMs = site.retryBudgetMs ?? 60_000;
  const maxCoolingMs = site.maxCoolingMs ?? 30_000;
  const baseBackoffMs = site.baseBackoffMs ?? 100;
  const jitter = () => Math.floor((random ? random() : 0) * 50);

  // 返回 null 表示允许，否则返回拒绝原因
  function checkScope(pathOrUrl) {
    let url;
    try {
      url = new URL(pathOrUrl, site.origin);
    } catch {
      return 'bad-url';
    }
    if (url.origin !== site.origin) return 'cross-origin';
    if (!url.pathname.startsWith(site.pathPrefix)) return 'path-prefix';
    if (!robots.allows(url.pathname)) return 'robots';
    return null;
  }

  async function singleAttempt(path, etag, skipScopeCheck) {
    let current = path;
    let etagForHop = etag;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (!skipScopeCheck) {
        const blocked = checkScope(current);
        if (blocked) throw new BlockedError(blocked);
      }
      const url = new URL(current, site.origin).href;
      const headers = {};
      if (etagForHop) headers['if-none-match'] = etagForHop;
      await scheduler.acquire();
      let res;
      try {
        res = await fetchImpl(url, { headers, redirect: 'manual' });
      } finally {
        scheduler.release();
      }
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        await res.arrayBuffer().catch(() => {});
        const location = res.headers.get('location');
        if (!location) throw new BlockedError('redirect-without-target');
        const next = new URL(location, url);
        // 下一跳重新核对范围；未获准的跳转（登录页、站外、越前缀）到此为止
        const blocked = checkScope(next.href);
        if (blocked) {
          logger.log('redirect-blocked', { site: site.key, reason: blocked });
          throw new BlockedError(blocked);
        }
        current = next.pathname + next.search;
        etagForHop = null; // ETag 只对原地址有效
        continue;
      }
      return res;
    }
    throw new BlockedError('too-many-redirects');
  }

  async function request(path, { etag, skipScopeCheck = false } = {}) {
    const started = clock.now();
    let attempt = 0;
    for (;;) {
      attempt++;
      let res;
      try {
        res = await singleAttempt(path, etag, skipScopeCheck);
      } catch (err) {
        if (err instanceof BlockedError) throw err;
        logger.log('request-network-error', {
          site: site.key,
          path: sanitizeUrlForLog(path),
          attempt,
        });
        if (attempt >= maxAttempts || clock.now() - started >= retryBudgetMs) {
          throw new GapError('network', attempt, clock.now() - started);
        }
        await clock.sleep(baseBackoffMs * 2 ** (attempt - 1) + jitter());
        continue;
      }
      if (res.status === 429) {
        await res.arrayBuffer().catch(() => {});
        const retryAfter = Number(res.headers.get('retry-after') ?? '1');
        const coolMs = Math.min(Math.max(0, retryAfter) * 1000, maxCoolingMs);
        scheduler.cool(coolMs);
        logger.log('rate-limited', { site: site.key, path: sanitizeUrlForLog(path), attempt, coolMs });
        if (attempt >= maxAttempts || clock.now() - started >= retryBudgetMs) {
          throw new GapError('rate-limited', attempt, clock.now() - started);
        }
        await clock.sleep(baseBackoffMs * 2 ** (attempt - 1) + jitter());
        continue;
      }
      return res;
    }
  }

  return { request, checkScope };
}
