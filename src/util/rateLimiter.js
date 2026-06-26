import { sleep } from './http.js';

/**
 * طابور ينفّذ المهام بفاصل زمني ثابت بين بداياتها (لبذر REST دون حظر).
 */
export class PacedQueue {
  constructor(delayMs) {
    this.delayMs = delayMs;
    this.chain = Promise.resolve();
  }
  add(task) {
    const run = this.chain.then(async () => {
      const out = await task();
      await sleep(this.delayMs);
      return out;
    });
    // نمنع كسر السلسلة عند خطأ مهمّة واحدة
    this.chain = run.catch(() => {});
    return run;
  }
}

/**
 * بوّابة تضمن فاصلاً أدنى بين عمليّتين (مثل تعديلات الرسالة المثبّتة).
 */
export class MinIntervalGate {
  constructor(minMs) {
    this.minMs = minMs;
    this.last = 0;
  }
  async wait() {
    const now = Date.now();
    const since = now - this.last;
    if (since < this.minMs) await sleep(this.minMs - since);
    this.last = Date.now();
  }
  ready() {
    return Date.now() - this.last >= this.minMs;
  }
}
