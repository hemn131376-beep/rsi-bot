import { BaseAdapter } from './base.js';
import { getJson, sleep } from '../util/http.js';
import { config } from '../config.js';

const REST = 'https://www.okx.com';
const WS = 'wss://ws.okx.com:8443/ws/v5/business';

// قنوات الشموع (UTC للأيام والأسابيع لمطابقة المنصّات)
const CH = { '1h': 'candle1H', '4h': 'candle4H', '1d': 'candle1Dutc', '1w': 'candle1Wutc' };
const BAR = { '1h': '1H', '4h': '4H', '1d': '1Dutc', '1w': '1Wutc' };
const invCh = (c) => Object.keys(CH).find((k) => CH[k] === c) ?? c;

export class OKXAdapter extends BaseAdapter {
  constructor() {
    super('okx');
    this.shardSize = 100;
  }

  static async fetchInstruments(btcUsd) {
    const [inst, tick] = await Promise.all([
      getJson(`${REST}/api/v5/public/instruments?instType=SPOT`),
      getJson(`${REST}/api/v5/market/tickers?instType=SPOT`),
    ]);
    // volCcy24h = حجم بعملة الأساس؛ نضربه في السعر للحصول على قيمة بالعملة المسعّرة → ثم دولار
    const tickBy = new Map((tick.data || []).map((t) => [t.instId, t]));
    const out = [];
    for (const i of inst.data || []) {
      if (i.state !== 'live') continue;
      const quote = i.quoteCcy;
      if (!config.quotePriority.includes(quote)) continue;
      const t = tickBy.get(i.instId);
      const quoteVol = t ? Number(t.volCcy24h) : 0; // بالعملة المسعّرة
      const volUsd = quote === 'BTC' ? quoteVol * (btcUsd || 0) : quoteVol;
      out.push({ base: i.baseCcy, quote, symbol: i.instId, volUsd });
    }
    return out;
  }

  async seed(symbol, tf, limit = config.seedCandles) {
    const data = await getJson(`${REST}/api/v5/market/candles?instId=${symbol}&bar=${BAR[tf]}&limit=${Math.min(limit, 300)}`);
    // الأحدث أولاً → نعكس. الصيغة: [ts,o,h,l,c,vol,...]
    const rows = (data.data || []).slice().reverse();
    return rows.map((r) => Number(r[4]));
  }

  async wsUrl() { return WS; }

  buildSubscribe(items) {
    const args = items.map((i) => ({ channel: CH[i.tf], instId: i.symbol }));
    // OKX يقبل عدّة args في رسالة واحدة
    return [{ op: 'subscribe', args }];
  }

  keepalive(ws) {
    const t = setInterval(() => {
      try { if (ws.readyState === ws.OPEN) ws.send('ping'); } catch {}
    }, 25_000);
    return () => clearInterval(t);
  }

  parseMessage(raw, conn) {
    const text = raw.toString();
    if (text === 'pong') return;
    const msg = JSON.parse(text);
    if (msg.event) return; // subscribe/error ack
    const ch = msg?.arg?.channel;
    const instId = msg?.arg?.instId;
    if (!ch || !msg.data) return;
    const tf = invCh(ch);
    const item = conn.items.find((i) => i.symbol === instId && i.tf === tf);
    for (const row of msg.data) {
      // [ts,o,h,l,c,vol,volCcy,volCcyQuote,confirm]
      const closePrice = row[4];
      const confirm = row[row.length - 1];
      this.emitKline({
        base: item?.base ?? instId?.split('-')[0],
        symbol: instId,
        tf,
        closeTime: Number(row[0]),
        closePrice,
        isClosed: confirm === '1',
      });
    }
  }
}
