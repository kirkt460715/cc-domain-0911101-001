// 扫描引擎：跟随列表分页与详情链接，处理相对链接、同页重复链接、
// 循环导航、条件请求与代次核对。所有写入都经过 store 的门控。
//
// 代次纪律：
// - 扫描开始时以清单代次为边界；任何响应的 x-data-generation 与扫描代次
//   不一致，立即放弃本轮（已提交记录保留，但不做任何下架判定）。
// - 只有分页与详情全部在同一代次完成遍历，才 finalize 切换完整视图。
// - 分页没走完、详情有失败缺口，都只记录可解释的缺口状态，绝不删除记录。

import { parseListPage, parseDetailPage } from './parse.js';
import { normalizePath, sanitizeUrlForLog } from './sanitize.js';
import { BlockedError } from './http.js';

function removePending(scan, id) {
  scan.details.pending = scan.details.pending.filter(x => x !== id);
}

export async function executeScan(ctx) {
  const { site, store, http, logger, manifest, clock } = ctx;

  let scan = store.state.scan;
  if (!scan || scan.generation !== manifest.generation) {
    scan = store.startScan(manifest.generation, manifest.expectedPages);
    const entry = normalizePath(new URL(manifest.entry ?? '/catalog/list?page=1', site.origin));
    const blocked = http.checkScope(entry);
    if (blocked) throw new Error(`清单入口超出获准范围（${blocked}）`);
    scan.pages.queue.push(entry);
    await store.save();
    logger.log('scan-started', { site: site.key, generation: scan.generation });
  } else {
    // 断点续传：上一轮失败的页与详情重新排队，已确认的不重抓
    scan.pages.queue.push(...scan.pages.failed.splice(0).map(f => f.key));
    scan.details.pending.push(...scan.details.failed.splice(0).map(f => f.id));
    scan.retries++;
    await store.save();
    logger.log('scan-resumed', { site: site.key, generation: scan.generation, retries: scan.retries });
  }

  // —— 阶段一：分页遍历 ——
  while (scan.pages.queue.length > 0) {
    if (store.state.scan !== scan) return 'aborted';
    const pageKey = scan.pages.queue.shift();
    if (scan.pages.done.includes(pageKey)) continue; // 循环导航/重复链接到此为止
    const cached = store.state.cache.lists[pageKey];
    let res;
    try {
      res = await http.request(pageKey, { etag: cached?.etag ?? undefined });
    } catch (err) {
      const reason = err instanceof BlockedError ? 'out-of-scope' : (err.reason ?? 'network');
      const attempts = err.attempts ?? 0;
      scan.pages.failed.push({ key: pageKey, reason, attempts });
      logger.log('page-failed', { site: site.key, page: sanitizeUrlForLog(pageKey), reason, attempts });
      await store.save();
      continue;
    }
    const generation = Number(res.headers.get('x-data-generation'));
    if (generation !== scan.generation) return 'generation-changed';
    if (res.status === 304) {
      if (!cached) {
        scan.pages.failed.push({ key: pageKey, reason: 'unexpected-not-modified', attempts: 1 });
        await store.save();
        continue;
      }
      absorbListLinks(ctx, scan, cached);
    } else if (res.status === 200) {
      const body = await res.text();
      const links = resolveListLinks(ctx, pageKey, parseListPage(body));
      store.cacheList(pageKey, res.headers.get('etag'), links);
      absorbListLinks(ctx, scan, links);
    } else {
      await res.arrayBuffer().catch(() => {});
      scan.pages.failed.push({ key: pageKey, reason: `http-${res.status}`, attempts: 1 });
      await store.save();
      continue;
    }
    scan.pages.done.push(pageKey);
    await store.save();
  }

  // —— 阶段二：详情确认 ——
  while (scan.details.pending.length > 0) {
    if (store.state.scan !== scan) return 'aborted';
    const id = scan.details.pending[0];
    const path = scan.details.paths[id];
    if (!path) {
      removePending(scan, id);
      continue;
    }
    const cached = store.state.cache.details[id];
    let res;
    try {
      res = await http.request(path, { etag: cached?.etag });
    } catch (err) {
      const reason = err instanceof BlockedError ? 'out-of-scope' : (err.reason ?? 'network');
      const attempts = err.attempts ?? 0;
      removePending(scan, id);
      scan.details.failed.push({ id, reason, attempts });
      logger.log('detail-failed', { site: site.key, id, reason, attempts });
      await store.save();
      continue;
    }
    const generation = Number(res.headers.get('x-data-generation'));
    if (generation !== scan.generation) return 'generation-changed';

    if (res.status === 404) {
      await res.arrayBuffer().catch(() => {});
      removePending(scan, id);
      delete scan.details.paths[id];
      delete store.state.cache.details[id];
      logger.log('detail-gone', { site: site.key, id });
      // 源站可能同时调整了授权：先确认清单再继续
      await ctx.refreshManifest();
      await store.save();
      continue;
    }
    if (res.status === 304) {
      const outcome = store.confirmDetail(id, scan.generation);
      if (outcome === 'no-record') {
        // 有 ETag 但没有记录（例如撤回重开后）：去掉条件头重新抓取
        delete store.state.cache.details[id];
        await store.save();
        continue;
      }
      if (outcome.startsWith('dropped')) {
        logger.log('detail-dropped', { site: site.key, id, reason: outcome });
      }
      removePending(scan, id);
      scan.details.done.push(id);
      await store.save();
      continue;
    }
    if (res.status !== 200) {
      await res.arrayBuffer().catch(() => {});
      removePending(scan, id);
      scan.details.failed.push({ id, reason: `http-${res.status}`, attempts: 1 });
      await store.save();
      continue;
    }
    const body = await res.text();
    const parsed = parseDetailPage(body);
    if (!parsed || !parsed.id || !Number.isInteger(parsed.version)) {
      removePending(scan, id);
      scan.details.failed.push({ id, reason: 'unparseable', attempts: 1 });
      await store.save();
      continue;
    }
    const outcome = store.commitDetail({
      id: parsed.id,
      version: parsed.version,
      generation,
      fields: parsed.fields,
      etag: res.headers.get('etag'),
      path,
    });
    if (outcome.startsWith('dropped')) {
      logger.log('detail-dropped', { site: site.key, id: parsed.id, reason: outcome });
    }
    removePending(scan, id);
    if (parsed.id !== id) removePending(scan, parsed.id);
    scan.details.done.push(parsed.id);
    await store.save();
  }

  // —— 阶段三：只有同代次完整遍历才切换完整视图 ——
  if (store.state.scan !== scan) return 'aborted';
  const gaps = {
    pages: scan.pages.failed.map(f => ({ page: sanitizeUrlForLog(f.key), reason: f.reason, attempts: f.attempts })),
    details: scan.details.failed.map(f => ({ id: f.id, reason: f.reason, attempts: f.attempts })),
  };
  const complete =
    gaps.pages.length === 0 &&
    gaps.details.length === 0 &&
    scan.pages.done.length >= scan.expectedPages;
  if (complete) {
    store.finalizeScan();
    await store.save();
    logger.log('scan-complete', { site: site.key, generation: scan.generation });
    return 'complete';
  }
  store.state.lastResult = {
    type: 'incomplete',
    generation: scan.generation,
    gaps,
    at: clock.nowISO(),
  };
  await store.save();
  logger.log('scan-incomplete', { site: site.key, generation: scan.generation, gaps });
  return 'incomplete';
}

// 把一页中提取到的链接解析成本站规范键；越范围或被 robots 禁止的链接
// 只记录一条清洗过的跳过事件，绝不进入待抓队列。
function resolveListLinks(ctx, pageKey, parsed) {
  const { site, http, logger } = ctx;
  const base = site.origin + pageKey;
  let next = null;
  if (parsed.next) {
    const key = normalizePath(new URL(parsed.next, base));
    const blocked = http.checkScope(key);
    if (blocked) logger.log('link-skipped', { site: site.key, kind: 'next', reason: blocked });
    else next = key;
  }
  const details = [];
  for (const d of parsed.details) {
    const path = normalizePath(new URL(d.href, base), { keepPage: false });
    const blocked = http.checkScope(path);
    if (blocked) {
      logger.log('link-skipped', { site: site.key, kind: 'detail', reason: blocked });
      continue;
    }
    details.push({ id: d.id, path });
  }
  return { next, details };
}

function absorbListLinks(ctx, scan, links) {
  const { store, site, logger } = ctx;
  if (
    links.next &&
    !scan.pages.done.includes(links.next) &&
    !scan.pages.queue.includes(links.next) &&
    !scan.pages.failed.some(f => f.key === links.next)
  ) {
    scan.pages.queue.push(links.next);
  }
  const known = new Set([
    ...scan.details.pending,
    ...scan.details.done,
    ...scan.details.failed.map(f => f.id),
  ]);
  for (const d of links.details) {
    if (store.state.grant.revokedIds.includes(d.id)) {
      logger.log('detail-skipped-revoked', { site: site.key, id: d.id });
      continue;
    }
    if (known.has(d.id)) continue;
    known.add(d.id);
    scan.details.pending.push(d.id);
    scan.details.paths[d.id] = d.path;
  }
}
