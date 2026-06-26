import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { config } from '../config.js';
import { makeLogger } from '../util/logger.js';

/**
 * BaseAdapter: يوفّر بنية اتصال WS مشرذمة (sharded) مع:
 *  - reconnect + backoff تصاعدي
 *  - keepalive لكل منصة
 *  - حارس خمول لكل اتصال (watchdog)
 *  - إعادة بذر الحالة قبل استئناف البثّ بعد أي انقطاع
 *
 * الأصناف الوارثة تنفّذ:
 *   tfMap                       خريطة الفريم القانوني → رمز المنصة
 *   wsUrl()                     عنوان WS (قد يكون async لطلب توكن)
 *   buildSubscribe(items)       رسالة/رسائل الاشتراك لقائمة عناصر شارد
 *   parseMessage(raw, ctx)      → يطلق this.emitKline(...) لكل شمعة، أو يردّ على ping
 *   keepalive(ws)               (اختياري) إرسال ping دوري — يردّ وظيفة إيقاف
 *   shardSize                   أقصى عدد اشتراكات لكل اتصال
 */
export class BaseAdapter extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.log = makeLogger(name);
    this.shardSize = 150;
    this.conns = []; // { ws, items, lastMsg, backoff, alive, keepaliveStop, reconnectTimer, closedByUs }
    this.onReseed = null; // حقنة من المحرّك: async (items) => void
    this.stopped = false;
  }

  // ── أدوات للأصناف الوارثة ──────────────────────────────────
  baseFromSymbol(symbol, sep = '') {
    // تُستبدل في المحوّلات التي تعرف الفصل؛ افتراضياً نعتمد item.base
    return symbol;
  }

  emitKline({ base, symbol, tf, closeTime, closePrice, isClosed }) {
    this.emit('kline', {
      exchange: this.name,
      base,
      symbol,
      tf,
      closeTime,
      closePrice: Number(closePrice),
      isClosed: !!isClosed,
    });
  }

  // ── دورة الحياة ────────────────────────────────────────────
  /** items: [{ symbol, base, tf }] */
  async subscribe(items) {
    const shards = [];
    for (let i = 0; i < items.length; i += this.shardSize) {
      shards.push(items.slice(i, i + this.shardSize));
    }
    this.log.info(`فتح ${shards.length} اتصال WS لـ${items.length} اشتراك`);
    for (const shard of shards) {
      const conn = { items: shard, ws: null, lastMsg: Date.now(), backoff: config.reconnectBaseMs, alive: false, keepaliveStop: null, reconnectTimer: null, closedByUs: false };
      this.conns.push(conn);
      await this._open(conn);
    }
  }

  async _open(conn) {
    if (this.stopped) return;
    let url;
    try {
      url = await this.wsUrl(conn);
    } catch (err) {
      this.log.error('فشل تجهيز عنوان WS:', err.message);
      return this._scheduleReconnect(conn);
    }

    const ws = new WebSocket(url);
    conn.ws = ws;
    conn.closedByUs = false;

    ws.on('open', async () => {
      conn.alive = true;
      conn.lastMsg = Date.now();
      conn.backoff = config.reconnectBaseMs;
      this.log.info(`اتصال مفتوح (${conn.items.length} اشتراك)`);
      try {
        // إعادة البذر قبل استئناف البثّ — لا نثق بالحالة القديمة أبداً
        if (this.onReseed) await this.onReseed(conn.items);
        const subs = this.buildSubscribe(conn.items, conn);
        for (const s of subs) ws.send(typeof s === 'string' ? s : JSON.stringify(s));
        if (this.keepalive) conn.keepaliveStop = this.keepalive(ws, conn);
      } catch (err) {
        this.log.error('فشل أثناء الاشتراك/البذر:', err.message);
        try { ws.close(); } catch {}
      }
    });

    ws.on('message', (raw) => {
      conn.lastMsg = Date.now();
      try {
        this.parseMessage(raw, conn);
      } catch (err) {
        this.log.debug('parse error:', err.message);
      }
    });

    ws.on('pong', () => { conn.lastMsg = Date.now(); });

    ws.on('error', (err) => {
      this.log.warn('خطأ WS:', err.message);
    });

    ws.on('close', () => {
      conn.alive = false;
      if (conn.keepaliveStop) { conn.keepaliveStop(); conn.keepaliveStop = null; }
      if (!this.stopped && !conn.closedByUs) {
        this.log.warn('انقطاع — جدولة إعادة اتصال');
        this._scheduleReconnect(conn);
      }
    });
  }

  _scheduleReconnect(conn) {
    if (this.stopped) return;
    clearTimeout(conn.reconnectTimer);
    const wait = conn.backoff;
    conn.backoff = Math.min(conn.backoff * 2, config.reconnectMaxMs);
    conn.reconnectTimer = setTimeout(() => this._open(conn), wait);
  }

  /** يُستدعى من الحارس: يفحص ويعيد ربط الاتصالات الميتة. */
  watchdogSweep() {
    const now = Date.now();
    for (const conn of this.conns) {
      const silent = now - conn.lastMsg;
      if (silent > config.watchdogTimeoutMs) {
        this.log.warn(`ستريم صامت ${Math.round(silent / 1000)}ث — إعادة ربط قسريّة`);
        conn.closedByUs = true;
        try { conn.ws?.terminate?.(); } catch {}
        conn.closedByUs = false;
        this._scheduleReconnect(conn);
      }
    }
  }

  health() {
    const live = this.conns.filter((c) => c.alive).length;
    const subs = this.conns.reduce((s, c) => s + c.items.length, 0);
    return { exchange: this.name, connections: this.conns.length, liveConnections: live, subscriptions: subs };
  }

  stop() {
    this.stopped = true;
    for (const conn of this.conns) {
      conn.closedByUs = true;
      clearTimeout(conn.reconnectTimer);
      if (conn.keepaliveStop) conn.keepaliveStop();
      try { conn.ws?.close(); } catch {}
    }
  }
}

/**
 * مساعد لاستنتاج طول الفريم بالميلي ثانية (لإغلاق الشموع المستنتَج).
 */
export const TF_MS = {
  '1h': 3_600_000,
  '4h': 14_400_000,
  '1d': 86_400_000,
  '1w': 604_800_000,
};
