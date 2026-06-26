import { BaseAdapter } from './base.js';
import { getJson } from '../util/http.js';
import { config } from '../config.js';

const REST = 'https://api.binance.com';
const WS = 'wss://stream.binance.com:9443/stream?streams=';

const TF = { '1h': '1h', '4h': '4h', '1d': '1d', '1w': '1w' };
const invTf = (b) => Object.keys(TF).find((k) => TF[k] === b) ?? b;

export class BinanceAdapter extends BaseAdapter {
  constructor() {
    super('binance');
    this.shardSize = 200; // الحدّ ~1024 ستريم/اتصال؛ نبقى محافظين
  }

  /** قائمة الأدوات الحيّة + حجم 24س بالدولار التقريبي. */
  static async fetchInstruments(btcUsd) {
    const [info, tickers] = await Promise.all([
      getJson(`${REST}/api/v3/exchangeInfo`),
      getJson(`${REST}/api/v3/ticker/24hr`),
    ]);
    const volBySym = new Map(tickers.map((t) => [t.symbol, Number(t.quoteVolume)]));
    const out = [];
    for (const s of info.symbols) {
      if (s.status !== 'TRADING' || !s.isSpotTradingAllowed) continue;
      const quote = s.quoteAsset;
      if (!config.quotePriority.includes(quote)) continue;
      const qv = volBySym.get(s.symbol) ?? 0;
      const volUsd = quote === 'BTC' ? qv * (btcUsd || 0) : qv;
      out.push({ base: s.baseAsset, quote, symbol: s.symbol, volUsd });
    }
    return out;
  }

  static async btcUsd() {
    try {
      const t = await getJson(`${REST}/api/v3/ticker/price?symbol=BTCUSDT`);
      return Number(t.price);
    } catch { return 0; }
  }

  /** أسعار إغلاق مرتّبة زمنياً (الأقدم أولاً). */
  async seed(symbol, tf, limit = config.seedCandles) {
    const data = await getJson(`${REST}/api/v3/klines?symbol=${symbol}&interval=${TF[tf]}&limit=${limit}`);
    return data.map((k) => Number(k[4])); // close
  }

  // الستريمات تُضمَّن في عنوان الاتصال (أمتن لإعادة الاتصال، بلا رسالة SUBSCRIBE)
  async wsUrl(conn) {
    const streams = conn.items.map((i) => `${i.symbol.toLowerCase()}@kline_${TF[i.tf]}`);
    return WS + streams.join('/');
  }

  buildSubscribe() { return []; }

  parseMessage(raw, conn) {
    const msg = JSON.parse(raw.toString());
    const k = msg?.data?.k;
    if (!k) return;
    const symbol = msg.data.s;
    const item = conn.items.find((i) => i.symbol === symbol && TF[i.tf] === k.i);
    this.emitKline({
      base: item?.base ?? symbol,
      symbol,
      tf: item?.tf ?? invTf(k.i),
      closeTime: k.T,
      closePrice: k.c,
      isClosed: k.x === true,
    });
  }
}
