import { BaseAdapter, TF_MS } from './base.js';
import { getJson, sleep } from '../util/http.js';
import { config } from '../config.js';

const REST = 'https://api.kucoin.com';

const TYPE = { '1h': '1hour', '4h': '4hour', '1d': '1day', '1w': '1week' };
const invType = (t) => Object.keys(TYPE).find((k) => TYPE[k] === t) ?? t;

export class KuCoinAdapter extends BaseAdapter {
  constructor() {
    super('kucoin');
    this.shardSize = 250;          // الحدّ ~300 topic/اتصال
    this.pingIntervalMs = 18_000;  // يُحدَّث من ردّ التوكن
  }

  static async fetchInstruments(btcUsd) {
    const [symbols, tickers] = await Promise.all([
      getJson(`${REST}/api/v1/symbols`),
      getJson(`${REST}/api/v1/market/allTickers`),
    ]);
    const volBy = new Map((tickers.data?.ticker || []).map((t) => [t.symbol, Number(t.volValue)])); // volValue = حجم بالعملة المسعّرة
    const out = [];
    for (const s of symbols.data || []) {
      if (s.enableTrading === false) continue;
      const quote = s.quoteCurrency;
      if (!config.quotePriority.includes(quote)) continue;
      const sym = `${s.baseCurrency}-${s.quoteCurrency}`;
      const qv = volBy.get(sym) ?? 0;
      const volUsd = quote === 'BTC' ? qv * (btcUsd || 0) : qv;
      out.push({ base: s.baseCurrency, quote, symbol: sym, volUsd });
    }
    return out;
  }

  async seed(symbol, tf, limit = config.seedCandles) {
    const now = Math.floor(Date.now() / 1000);
    const startAt = now - Math.ceil((limit + 5) * (TF_MS[tf] / 1000));
    const data = await getJson(`${REST}/api/v1/market/candles?symbol=${symbol}&type=${TYPE[tf]}&startAt=${startAt}&endAt=${now}`);
    // الأحدث أولاً → نعكس. الصيغة: [time,open,close,high,low,vol,turnover]
    const rows = (data.data || []).slice().reverse();
    return rows.map((r) => Number(r[2])).slice(-limit);
  }

  async wsUrl() {
    const res = await getJson(`${REST}/api/v1/bullet-public`, { method: 'POST' });
    const server = res.data.instanceServers[0];
    this.pingIntervalMs = Math.max(10_000, Number(server.pingInterval) - 2_000);
    return `${server.endpoint}?token=${res.data.token}&connectId=${Date.now()}`;
  }

  buildSubscribe(items) {
    return items.map((i, idx) => ({
      id: Date.now() + idx,
      type: 'subscribe',
      topic: `/market/candles:${i.symbol}_${TYPE[i.tf]}`,
      privateChannel: false,
      response: true,
    }));
  }

  keepalive(ws) {
    const t = setInterval(() => {
      try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ id: Date.now(), type: 'ping' })); } catch {}
    }, this.pingIntervalMs);
    return () => clearInterval(t);
  }

  parseMessage(raw, conn) {
    const msg = JSON.parse(raw.toString());
    if (msg.type !== 'message' || !msg.topic?.startsWith('/market/candles:')) return;
    // topic: /market/candles:ADA-USDT_1hour
    const after = msg.topic.split(':')[1];
    const us = after.lastIndexOf('_');
    const symbol = after.slice(0, us);
    const type = after.slice(us + 1);
    const tf = invType(type);
    const item = conn.items.find((i) => i.symbol === symbol && i.tf === tf);
    const candles = msg.data?.candles;
    if (!candles) return;
    // [time(sec), open, close, high, low, vol, turnover]
    const start = Number(candles[0]) * 1000;
    const close = candles[2];
    const key = `${symbol}_${type}`;
    if (!this._cur) this._cur = new Map();
    const prev = this._cur.get(key);
    const tfms = TF_MS[tf];

    if (prev && start > prev.start) {
      // دارت الشمعة: السابقة أُغلقت بآخر سعر معروف
      this.emitKline({ base: item?.base ?? symbol.split('-')[0], symbol, tf, closeTime: prev.start + tfms, closePrice: prev.close, isClosed: true });
      this._cur.set(key, { start, close });
    } else if (!prev || start === prev.start) {
      this._cur.set(key, { start, close });
    }
    // تحديث الشمعة المفتوحة الجارية
    this.emitKline({ base: item?.base ?? symbol.split('-')[0], symbol, tf, closeTime: start + tfms, closePrice: close, isClosed: false });
  }
}
