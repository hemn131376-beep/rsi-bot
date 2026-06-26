import { config } from './config.js';
import { makeLogger } from './util/logger.js';

const log = makeLogger('state');

/**
 * آلة حالة التنبيه لكل مفتاح (exchange·base·tf):
 *   IDLE → IN_ZONE عند provRSI < 7 (تنبيه دخول فوري + إضافة للقائمة)
 *   IN_ZONE → IDLE عند provRSI > 10 (تنبيه خروج + حذف)
 *   الفجوة 7↔10 تمنع الرفرفة.
 *
 * «المنطقة» محفوظة في الذاكرة ومُزامَنة مع Postgres للنجاة عبر إعادة التشغيل.
 */
export class StateMachine {
  constructor({ db, telegram }) {
    this.db = db;
    this.telegram = telegram;
    this.zone = new Map(); // key → { exchange, base, symbol, tf, entryRsi, entryTime, lastRsi, prevDigestRsi }
    this._pinnedDirty = false;
  }

  /** استرجاع المجموعة من DB عند الإقلاع. */
  async hydrate() {
    const rows = await this.db.loadZone();
    for (const r of rows) {
      this.zone.set(`${r.exchange}|${r.base}|${r.tf}`, {
        exchange: r.exchange,
        base: r.base,
        symbol: r.symbol,
        tf: r.tf,
        entryRsi: Number(r.entry_rsi),
        entryTime: r.entry_time,
        lastRsi: r.last_reported_rsi != null ? Number(r.last_reported_rsi) : Number(r.entry_rsi),
        prevDigestRsi: r.last_reported_rsi != null ? Number(r.last_reported_rsi) : Number(r.entry_rsi),
      });
    }
    log.info(`استُرجِع ${this.zone.size} عنصراً داخل المنطقة من قاعدة البيانات`);
  }

  inZone() {
    return [...this.zone.values()];
  }

  /** معالجة تحديث RSI من المحرّك. */
  async onRsi(ev) {
    const { key, exchange, base, symbol, tf, provRSI } = ev;
    const present = this.zone.has(key);

    if (!present && provRSI < config.entryThreshold) {
      // ── دخول ──
      const item = {
        exchange, base, symbol, tf,
        entryRsi: provRSI,
        entryTime: new Date(),
        lastRsi: provRSI,
        prevDigestRsi: provRSI,
      };
      this.zone.set(key, item);
      await this.db.upsertZone(item);
      log.info(`دخول ${base}·${exchange}·${tf} RSI ${provRSI.toFixed(1)}`);
      await this.telegram.sendEntryAlert(item);
      this._pinnedDirty = true;
    } else if (present) {
      const item = this.zone.get(key);
      item.lastRsi = provRSI;
      if (provRSI > config.exitThreshold) {
        // ── خروج ──
        this.zone.delete(key);
        await this.db.deleteZone(key);
        log.info(`خروج ${base}·${exchange}·${tf} RSI ${provRSI.toFixed(1)}`);
        if (config.sendExitAlert) await this.telegram.sendExitAlert(item, provRSI);
        this._pinnedDirty = true;
      } else {
        // ── بقاء (7–10) ── تحديث خفيف للرسالة المثبّتة
        this._pinnedDirty = true;
      }
    }
  }

  /** يُستدعى بشكل خفيف لتحديث الرسالة المثبّتة عند وجود تغيير. */
  async maybeRefreshPinned() {
    if (!this._pinnedDirty) return;
    this._pinnedDirty = false;
    await this.telegram.refreshPinned(this.sortedZone());
  }

  sortedZone() {
    return this.inZone().sort((a, b) => a.lastRsi - b.lastRsi);
  }

  /** بناء أسطر الديجست مع أسهم الاتجاه، وتحديث المرجع وDB. */
  async buildDigestAndAdvance() {
    const items = this.sortedZone();
    const lines = [];
    for (const it of items) {
      const arrow = it.lastRsi < it.prevDigestRsi - 0.05 ? '↓'
        : it.lastRsi > it.prevDigestRsi + 0.05 ? '↑' : '→';
      lines.push({ ...it, arrow });
      it.prevDigestRsi = it.lastRsi;
      const key = `${it.exchange}|${it.base}|${it.tf}`;
      await this.db.updateReported(key, it.lastRsi);
    }
    return lines;
  }
}
