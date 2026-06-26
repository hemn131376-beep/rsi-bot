import { BaseAdapter, TF_MS } from './base.js';
import { getJson } from '../util/http.js';
import { config } from '../config.js';

const REST = 'https://api.mexc.com';
const WS = 'wss://wbs.mexc.com/ws';

// فريمات MEXC: WS مقابل REST
const WS_TF = { '1h': 'Min60', '4h': 'Hour4', '1d': 'Day1', '1w': 'Week1' };
const REST_TF = { '1h': '60m', '4h': '4h', '1d': '1d', '1w': '1W' };
const invWsTf = (v) => Object.keys(WS_TF).find((k) => WS_TF[k] === v) ?? v;

export class MexcAdapter extends BaseAdapter {
  constructor() {
    super('mexc');
    this.shardSize = 20; // MEXC محافظ على عدد الاشتراكات لكل اتصال
  }

  static async fetchInstruments(btcUsd) {
    const [info, tickers] = await Promise.all([
      getJson(`${REST}/api/v3/exchangeInfo`),
      getJson(`${REST}/api/v3/ticker/24hr`),
    ]);
    const volBy = new Map((Array.isArray(tickers) ? tickers : []).map((t) => [t.symbol, Number(t.quoteVolume)]));
    const out = [];
    for (const s of info.symbols || []) {
      if (s.status !== '1' && s.status !== 'ENABLED' && s.status !== 'TRADING') continue;
      const quote = s.quoteAsset;
      if (!config.quotePriority.includes(quote)) continue;
      const qv = volBy.get(s.symbol) ?? 0;
      const volUsd = quote === 'BTC' ? qv * (btcUsd || 0) : qv;
      out.push({ base: s.baseAsset, quote, symbol: s.symbol, volUsd });
    }
    return out;
  }

  async seed(symbol, tf, limit = config.seedCandles) {
    const data = await getJson(`${REST}/api/v3/klines?symbol=${symbol}&interval=${REST_TF[tf]}&limit=${limit}`);
    // الأقدم أولاً: [openTime,o,h,l,c,vol,closeTime,...]
    return data.map((k) => Number(k[4]));
  }

  async wsUrl() { return WS; }

  buildSubscribe(items) {
    const params = items.map((i) => `spot@public.kline.v3.api@${i.symbol}@${WS_TF[i.tf]}`);
    // نجمّعها في رسالة اشتراك واحدة
    return [{ method: 'SUBSCRIPTION', params }];
  }

  keepalive(ws) {
    const t = setInterval(() => {
      try { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ method: 'PING' })); } catch {}
    }, 20_000);
    return () => clearInterval(t);
  }

  parseMessage(raw, conn) {
    const text = raw.toString();
    const msg = JSON.parse(text);
    if (msg.msg === 'PONG' || msg.id !== undefined) return; // ردود ping/ack
    const channel = msg.c || msg.channel;
    if (!channel || !channel.includes('public.kline')) return;
    // c: spot@public.kline.v3.api@ADAUSDT@Min60
    const parts = channel.split('@');
    const symbol = parts[2];
    const wsTf = parts[3];
    const tf = invWsTf(wsTf);
    const k = msg.d?.k || msg.d?.K || msg.d;
    if (!k) return;
    const start = Number(k.t ?? k.windowStart ?? 0) * (String(k.t).length > 11 ? 1 : 1000);
    const close = k.c ?? k.close;
    if (close == null) return;
    const tfms = TF_MS[tf];
    const item = conn.items.find((i) => i.symbol === symbol && i.tf === tf);
    const key = `${symbol}_${wsTf}`;
    if (!this._cur) this._cur = new Map();
    const prev = this._cur.get(key);

    if (prev && start > prev.start) {
      this.emitKline({ base: item?.base ?? symbol, symbol, tf, closeTime: prev.start + tfms, closePrice: prev.close, isClosed: true });
      this._cur.set(key, { start, close });
    } else if (!prev || start === prev.start) {
      this._cur.set(key, { start, close });
    }
    this.emitKline({ base: item?.base ?? symbol, symbol, tf, closeTime: start + tfms, closePrice: close, isClosed: false });
  }
}
