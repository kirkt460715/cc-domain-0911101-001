// 站点状态存储：每个站点一个 JSON 文件，tmp + rename 原子落盘。
//
// 文件里只有四类内容，且都不含原始 HTML、联系方式或带敏感参数的完整 URL：
//   grant   —— 本地已确认的最新授权（版本、字段范围、撤回编号、确认时间）
//   dataset —— 可查询视图：每个房源编号一条当前记录（版本、代次、授权依据、允许字段）
//   cache   —— 条件请求材料：列表页的 ETag 与已提取链接、详情页的 ETag
//   scan    —— 进行中的扫描游标（分页/详情进度与失败缺口），用于断点续传
//
// 授权语义：
// - applyManifest 只接受不低于本地已知版本的清单；更低版本视为重放，整体忽略。
//   确认新清单时立即在可查询视图中落实撤回与字段收窄，并同步清理缓存与
//   恢复材料，先于任何后续数据提交生效。
// - commitDetail / confirmDetail 是唯二的写入门控：撤回编号、过期代次、
//   更旧版本一律拒绝；字段在提交瞬间按当前有效允许清单裁剪。
//   ETag 只用于节省流量，不能证明权限，304 同样要过门控。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pickAllowed } from './sanitize.js';

function initialState(siteKey) {
  return {
    version: 1,
    siteKey,
    grant: { knownGrantVersion: 0, allowedFields: [], revokedIds: [], confirmedAt: null },
    dataset: { completeGeneration: 0, records: {} },
    cache: { lists: {}, details: {} },
    scan: null,
    lastResult: null,
  };
}

function sameSet(a, b) {
  return a.length === b.length && a.every(x => b.includes(x));
}

export class SiteStore {
  constructor({ dir, site, clock }) {
    this.dir = dir;
    this.site = site;
    this.clock = clock;
    this.file = join(dir, site.key + '.json');
    this.state = null;
    this._tail = null;
  }

  async load() {
    if (this.state) return;
    await mkdir(this.dir, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'));
      if (parsed.version !== 1) throw new Error(`状态文件版本不支持：${parsed.version}`);
      this.state = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      this.state = initialState(this.site.key);
    }
  }

  async _writeNow() {
    const tmp = this.file + '.tmp';
    await writeFile(tmp, JSON.stringify(this.state, null, 1));
    await rename(tmp, this.file);
  }

  // 串行化落盘，避免并发写同一文件；调用方在关键检查点 await。
  save() {
    const p = (this._tail ?? Promise.resolve()).then(() => this._writeNow());
    this._tail = p.catch(() => {});
    return p;
  }

  async flush() {
    await (this._tail ?? Promise.resolve());
  }

  // 配置允许字段 ∩ 清单允许字段，取更严格的一侧
  effectiveAllowed() {
    const granted = new Set(this.state.grant.allowedFields);
    return this.site.allowedFields.filter(f => granted.has(f));
  }

  applyManifest(manifest) {
    const g = this.state.grant;
    if (!Number.isInteger(manifest.grantVersion)) return { applied: false, reason: 'bad-manifest' };
    if (manifest.grantVersion < g.knownGrantVersion) {
      // 旧代次或重放的清单不能扩大授权
      return { applied: false, reason: 'stale-manifest' };
    }
    const changed =
      manifest.grantVersion > g.knownGrantVersion ||
      !sameSet(manifest.revoked ?? [], g.revokedIds) ||
      !sameSet(manifest.allowedFields ?? [], g.allowedFields);
    g.knownGrantVersion = manifest.grantVersion;
    g.allowedFields = [...(manifest.allowedFields ?? [])];
    g.revokedIds = [...(manifest.revoked ?? [])];
    g.confirmedAt = this.clock.nowISO();

    const effective = this.effectiveAllowed();
    const revoked = new Set(g.revokedIds);

    // 1) 可查询视图：撤回编号删除，其余记录按收窄后的字段范围清理
    for (const [id, record] of Object.entries(this.state.dataset.records)) {
      if (revoked.has(id)) {
        delete this.state.dataset.records[id];
      } else {
        record.fields = pickAllowed(record.fields, effective);
      }
    }
    // 2) 条件请求缓存：撤回编号的 ETag 与列表缓存中的撤回编号链接
    for (const id of revoked) delete this.state.cache.details[id];
    for (const page of Object.values(this.state.cache.lists)) {
      page.details = page.details.filter(d => !revoked.has(d.id));
    }
    // 3) 恢复材料：进行中的扫描不再抓取、不再等待撤回编号；
    //    清单代次与扫描代次不一致时，旧扫描整体作废（已提交记录保留，不得据此删除）
    const scan = this.state.scan;
    if (scan) {
      scan.details.pending = scan.details.pending.filter(id => !revoked.has(id));
      scan.details.done = scan.details.done.filter(id => !revoked.has(id));
      scan.details.failed = scan.details.failed.filter(f => !revoked.has(f.id));
      for (const id of revoked) delete scan.details.paths[id];
      if (scan.generation !== manifest.generation) {
        this.state.scan = null;
        this.state.lastResult = {
          type: 'aborted',
          reason: 'generation-changed',
          at: this.clock.nowISO(),
        };
      }
    }
    return { applied: true, changed };
  }

  startScan(generation, expectedPages) {
    this.state.scan = {
      generation,
      grantVersion: this.state.grant.knownGrantVersion,
      expectedPages: expectedPages ?? 0,
      startedAt: this.clock.nowISO(),
      retries: 0,
      pages: { done: [], queue: [], failed: [] },
      details: { pending: [], done: [], failed: [], paths: {} },
    };
    return this.state.scan;
  }

  cacheList(key, etag, links) {
    this.state.cache.lists[key] = {
      etag: etag ?? null,
      next: links.next ?? null,
      details: links.details.map(d => ({ id: d.id, path: d.path })),
    };
  }

  // 200 响应的写入门控
  commitDetail({ id, version, generation, fields, etag, path }) {
    const s = this.state;
    if (s.grant.revokedIds.includes(id)) return 'dropped:revoked';
    if (!s.scan || s.scan.generation !== generation) return 'dropped:stale-generation';
    const existing = s.dataset.records[id];
    if (existing && existing.version > version) return 'dropped:older-version';
    s.dataset.records[id] = {
      id,
      source: this.site.key,
      version,
      generation,
      grantVersion: s.grant.knownGrantVersion,
      fetchedAt: this.clock.nowISO(),
      fields: pickAllowed(fields, this.effectiveAllowed()),
    };
    if (etag) s.cache.details[id] = { etag, path };
    return existing ? 'restamped' : 'committed';
  }

  // 304 响应的确认门控：ETag 只代表内容未变，权限仍以本地已确认清单为准
  confirmDetail(id, generation) {
    const s = this.state;
    if (s.grant.revokedIds.includes(id)) return 'dropped:revoked';
    if (!s.scan || s.scan.generation !== generation) return 'dropped:stale-generation';
    const existing = s.dataset.records[id];
    if (!existing) return 'no-record';
    existing.generation = generation;
    existing.grantVersion = s.grant.knownGrantVersion;
    existing.fetchedAt = this.clock.nowISO();
    return 'confirmed';
  }

  // 只有清单与所有分页、详情同属一个代次且遍历完整，才允许切换完整视图：
  // 本轮没有重新确认的编号才视为下架。扫描中断或代次切换时不走这里。
  finalizeScan() {
    const s = this.state;
    const scan = s.scan;
    if (!scan) return false;
    for (const [id, record] of Object.entries(s.dataset.records)) {
      if (record.generation !== scan.generation) delete s.dataset.records[id];
    }
    s.dataset.completeGeneration = scan.generation;
    s.scan = null;
    s.lastResult = { type: 'complete', generation: scan.generation, at: this.clock.nowISO() };
    return true;
  }

  status() {
    const s = this.state;
    return {
      site: this.site.key,
      purpose: this.site.purpose,
      knownGrantVersion: s.grant.knownGrantVersion,
      revokedIds: [...s.grant.revokedIds],
      allowedFields: this.effectiveAllowed(),
      completeGeneration: s.dataset.completeGeneration,
      recordCount: Object.keys(s.dataset.records).length,
      scan: s.scan
        ? {
            generation: s.scan.generation,
            pagesDone: s.scan.pages.done.length,
            pagesQueued: s.scan.pages.queue.length,
            detailsDone: s.scan.details.done.length,
            detailsPending: s.scan.details.pending.length,
            detailsFailed: s.scan.details.failed.map(f => ({
              id: f.id,
              reason: f.reason,
              attempts: f.attempts,
            })),
          }
        : null,
      lastResult: s.lastResult,
    };
  }
}
