import { config } from './config.js';
import { ADAPTERS } from './exchanges/index.js';
import { BinanceAdapter } from './exchanges/binance.js';
import { makeLogger } from './util/logger.js';

const log = makeLogger('router');

/**
 * يبني خريطة التوجيه:
 *   لكل أصل من القائمة المغلقة → أوّل منصة (بترتيب cascade) تدرجه فعلياً
 *   بزوج سائل (USDT→USDC→BTC). غير المتوفّر/غير السائل → «غير مراقَب».
 *
 * يُرجِع: { routing: [{base,exchange,symbol,quote,volUsd}], unmonitored: [{base,reason}] }
 */
export async function buildRouting(whitelist) {
  const btcUsd = await BinanceAdapter.btcUsd();
  log.info(`سعر BTC المرجعي ≈ ${btcUsd ? '$' + Math.round(btcUsd) : 'غير متاح'}`);

  // اجلب أدوات كل منصة حيّاً (بالتوازي، مع تحمّل فشل منصة)
  const instByExchange = {};
  await Promise.all(
    config.cascade.map(async (name) => {
      try {
        const Adapter = ADAPTERS[name];
        const list = await Adapter.fetchInstruments(btcUsd);
        instByExchange[name] = indexInstruments(list);
        log.info(`${name}: ${list.length} زوج حيّ`);
      } catch (err) {
        instByExchange[name] = new Map();
        log.error(`فشل جلب أدوات ${name}: ${err.message}`);
      }
    }),
  );

  const routing = [];
  const unmonitored = [];

  for (const base of whitelist) {
    let assigned = null;
    let sawButIlliquid = false;

    for (const exchange of config.cascade) {
      const byBase = instByExchange[exchange];
      const candidates = byBase.get(base);
      if (!candidates || !candidates.length) continue;

      // على هذه المنصّة: اختر أعلى زوج بالأولوية (USDT→USDC→BTC) يكون سائلاً.
      // إن وُجد زوج لكنّه دون حدّ السيولة، نعلّم ذلك ونتدرّج لمنصّة لاحقة.
      const liquid = candidates.filter((x) => x.volUsd >= config.minVolumeUsd);
      if (!liquid.length) {
        sawButIlliquid = true;
        continue; // قد تنجّيه منصة لاحقة بسيولة أعلى
      }

      const pick = pickByQuote(liquid);
      if (!pick) continue;

      assigned = { base, exchange, symbol: pick.symbol, quote: pick.quote, volUsd: pick.volUsd };
      break;
    }

    if (assigned) routing.push(assigned);
    else unmonitored.push({ base, reason: sawButIlliquid ? 'سيولة دون الحدّ' : 'غير مدرَج' });
  }

  // إحصاء التوزيع لكل منصة
  const dist = {};
  for (const r of routing) dist[r.exchange] = (dist[r.exchange] || 0) + 1;
  log.info(`التوجيه: ${routing.length} مراقَب، ${unmonitored.length} غير مراقَب`, dist);

  return { routing, unmonitored, dist, btcUsd };
}

function indexInstruments(list) {
  const m = new Map();
  for (const it of list) {
    if (!m.has(it.base)) m.set(it.base, []);
    m.get(it.base).push(it);
  }
  return m;
}

function pickByQuote(candidates) {
  for (const q of config.quotePriority) {
    const c = candidates.find((x) => x.quote === q);
    if (c) return c;
  }
  return null;
}
