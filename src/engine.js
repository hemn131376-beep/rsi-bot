import { EventEmitter } from 'node:events';
import { WilderRSI } from './rsi.js';
import { config } from './config.js';
import { makeLogger } from './util/logger.js';
import { PacedQueue } from './util/rateLimiter.js';

const log = makeLogger('engine');
const keyOf = (exchange, base, tf) => `${exchange}|${base}|${tf}`;

/**
 * المحرّك: يحتفظ بحالة WilderRSI لكل مفتاح، يستقبل الأحداث الموحّدة من المحوّلات،
 * يحسب provRSI، ويطلق حدث 'rsi' لآلة الحالة.
 */
export class Engine extends EventEmitter {
  constructor() {
    super();
    this.state = new Map(); // key → { rsi, base, exchange, tf, symbol, lastPrice }
  }

  has(key) { return this.state.has(key); }

  /** تهيئة مفتاح من أسعار إغلاق مسحوبة عبر REST. */
  seedKey({ exchange, base, tf, symbol }, closes) {
    const key = keyOf(exchange, base, tf);
    let entry = this.state.get(key);
    if (!entry) {
      entry = { rsi: new WilderRSI(config.rsiPeriod), base, exchange, tf, symbol, lastPrice: null };
      this.state.set(key, entry);
    }
    entry.rsi.seed(closes);
    return key;
  }

  /** استقبال حدث kline موحّد من أي محوّل. */
  onKline(ev) {
    const key = keyOf(ev.exchange, ev.base, ev.tf);
    const entry = this.state.get(key);
    if (!entry || !entry.rsi.ready) return; // لم يُبذر بعد

    if (ev.isClosed) {
      entry.rsi.commit(ev.closePrice); // تثبيت الحالة الجديدة
    }
    entry.lastPrice = ev.closePrice;
    const provRSI = entry.rsi.provisional(ev.closePrice);
    if (provRSI == null) return;

    this.emit('rsi', {
      key,
      exchange: ev.exchange,
      base: ev.base,
      symbol: ev.symbol,
      tf: ev.tf,
      provRSI,
      price: ev.closePrice,
      isClosed: ev.isClosed,
    });
  }

  /**
   * إعادة بذر مجموعة عناصر (بعد إعادة اتصال). كلّ عنصر {symbol, base, tf}.
   * يحتاج دالة seedFn(symbol, tf) من المحوّل.
   */
  async reseed(exchange, items, seedFn) {
    if (!items?.length) return;
    const q = new PacedQueue(config.seedDelayMs);
    let ok = 0;
    let fail = 0;
    await Promise.all(
      items.map((it) =>
        q.add(async () => {
          try {
            const closes = await seedFn(it.symbol, it.tf);
            this.seedKey({ exchange, base: it.base, tf: it.tf, symbol: it.symbol }, closes);
            ok++;
          } catch (err) {
            fail++;
            log.debug(`reseed فشل ${it.symbol} ${it.tf}: ${err.message}`);
          }
        }),
      ),
    );
    log.info(`إعادة بذر ${exchange}: ${ok} نجحت، ${fail} فشلت`);
  }

  stats() {
    return { keys: this.state.size };
  }
}
