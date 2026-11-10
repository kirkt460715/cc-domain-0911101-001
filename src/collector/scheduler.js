// 单站点请求调度：并发上限 + 请求间隔 + 限流冷却。
// 每个站点各持有一个实例，因此一个站点收到 Retry-After 进入冷却时，
// 其他站点的调度完全不受影响。等待通过注入的时钟完成，可在测试中瞬时推进。

export class SiteScheduler {
  constructor({ clock, concurrency = 2, intervalMs = 0 }) {
    this.clock = clock;
    this.concurrency = Math.max(1, concurrency);
    this.intervalMs = Math.max(0, intervalMs);
    this.inflight = 0;
    this.lastStart = 0;
    this.coolingUntil = 0;
  }

  cool(ms) {
    this.coolingUntil = Math.max(this.coolingUntil, this.clock.now() + Math.max(0, ms));
  }

  async acquire() {
    for (;;) {
      const now = this.clock.now();
      const waitFor = Math.max(this.coolingUntil, this.lastStart + this.intervalMs) - now;
      if (this.inflight < this.concurrency && waitFor <= 0) {
        this.inflight++;
        this.lastStart = this.clock.now();
        return;
      }
      await this.clock.sleep(Math.max(waitFor, 1));
    }
  }

  release() {
    this.inflight = Math.max(0, this.inflight - 1);
  }
}
