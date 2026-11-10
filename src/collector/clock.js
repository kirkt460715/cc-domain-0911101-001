// 可替换的时钟与等待机制。
// 生产环境使用 realClock；测试与本地演练可以注入 ManualClock，
// 让限流冷却、重试退避等等待不消耗真实时间。

export const realClock = {
  now: () => Date.now(),
  nowISO: () => new Date().toISOString(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms))),
};

export class ManualClock {
  #now;
  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }
  now() {
    return this.#now;
  }
  nowISO() {
    return new Date(this.#now).toISOString();
  }
  async sleep(ms) {
    this.#now += Math.max(0, ms);
  }
  advance(ms) {
    this.#now += Math.max(0, ms);
  }
}
