import assert from 'node:assert';
import { loadWhitelist } from '../src/whitelist.js';
import { buildRouting } from '../src/router.js';
import { BinanceAdapter } from '../src/exchanges/binance.js';
import { OKXAdapter } from '../src/exchanges/okx.js';
import { KuCoinAdapter } from '../src/exchanges/kucoin.js';
import { MexcAdapter } from '../src/exchanges/mexc.js';
import { Engine } from '../src/engine.js';
import { StateMachine } from '../src/stateMachine.js';
import { buildPinnedText, splitChunks, renderDigestLine } from '../src/format.js';

let pass = 0;
const ok = (name) => { console.log('  ✓', name); pass++; };

// ── 1) قائمة الحلال ──
const wl = await loadWhitelist('data/halal_whitelist.sample.csv');
assert(wl.includes('BTC') && wl.includes('SUI'));
assert(!wl.some((b) => /USDT$/.test(b)));
ok('تحميل القائمة المغلقة وتنظيف الرموز');

// ── 2) الـRouter مع أدوات مزيّفة (cascade + سيولة + أولوية الزوج) ──
BinanceAdapter.btcUsd = async () => 60000;
BinanceAdapter.fetchInstruments = async () => [
  { base: 'BTC', quote: 'USDT', symbol: 'BTCUSDT', volUsd: 5e8 },
  { base: 'ETH', quote: 'USDT', symbol: 'ETHUSDT', volUsd: 3e8 },
  { base: 'ADA', quote: 'USDC', symbol: 'ADAUSDC', volUsd: 2e5 }, // USDC فقط على Binance
  { base: 'ADA', quote: 'USDT', symbol: 'ADAUSDT', volUsd: 1e3 }, // سيولة دون الحدّ → يُتجاوز
  { base: 'SOL', quote: 'BTC',  symbol: 'SOLBTC',  volUsd: 50 },  // BTC*price=3M؟ لا: 50*60000=3e6 سائل
];
OKXAdapter.fetchInstruments = async () => [
  { base: 'ADA', quote: 'USDT', symbol: 'ADA-USDT', volUsd: 9e6 },
  { base: 'SUI', quote: 'USDT', symbol: 'SUI-USDT', volUsd: 4e6 },
];
KuCoinAdapter.fetchInstruments = async () => [
  { base: 'INJ', quote: 'USDT', symbol: 'INJ-USDT', volUsd: 1e6 },
];
MexcAdapter.fetchInstruments = async () => [
  { base: 'FET', quote: 'USDT', symbol: 'FETUSDT', volUsd: 8e5 },
];

const { routing, unmonitored } = await buildRouting(['BTC', 'ETH', 'ADA', 'SOL', 'SUI', 'INJ', 'FET', 'XRP']);
const byBase = Object.fromEntries(routing.map((r) => [r.base, r]));

assert.equal(byBase.BTC.exchange, 'binance');
// ADA: على Binance USDC سائل (2e5>75k) يفوز قبل OKX (cascade)، وبأولوية... USDT دون السيولة فيُختار USDC
assert.equal(byBase.ADA.exchange, 'binance');
assert.equal(byBase.ADA.quote, 'USDC');
ok('ADA يُسنَد لأول منصة بزوج سائل (Binance/USDC) رغم توفّره على OKX');

assert.equal(byBase.SUI.exchange, 'okx');
assert.equal(byBase.INJ.exchange, 'kucoin');
assert.equal(byBase.FET.exchange, 'mexc');
ok('التدرّج عبر المنصّات يعمل (OKX→KuCoin→MEXC)');

assert(unmonitored.some((u) => u.base === 'XRP' && u.reason === 'غير مدرَج'));
ok('XRP غير المدرَج يدخل قائمة «غير مراقَب»');

// ── 3) المحرّك + آلة الحالة: دخول/بقاء/خروج (hysteresis) ──
const events = [];
const fakeDb = {
  loadZone: async () => [],
  upsertZone: async () => {},
  deleteZone: async () => {},
  updateReported: async () => {},
};
const fakeTg = {
  sendEntryAlert: async (it) => events.push(['entry', it.base, it.entryRsi]),
  sendExitAlert: async (it, rsi) => events.push(['exit', it.base, rsi]),
  refreshPinned: async () => {},
  sendDigest: async () => {},
};

const engine = new Engine();
const sm = new StateMachine({ db: fakeDb, telegram: fakeTg });
engine.on('rsi', (ev) => sm.onRsi(ev));

// نبني سعراً يجعل provRSI منخفضاً جداً ثم يتعافى. نبذر بسلسلة هابطة لطيفة.
const seed = [];
let p = 100;
for (let i = 0; i < 60; i++) { p += (i % 2 ? -0.3 : 0.2); seed.push(p); }
engine.seedKey({ exchange: 'binance', base: 'ADA', tf: '1h', symbol: 'ADAUSDT' }, seed);

const lastClose = seed[seed.length - 1];
// سعر منهار → provRSI < 7 (دخول)
engine.onKline({ exchange: 'binance', base: 'ADA', tf: '1h', symbol: 'ADAUSDT', closeTime: 1, closePrice: lastClose * 0.5, isClosed: false });
await tick();
assert(events.some((e) => e[0] === 'entry' && e[1] === 'ADA'), 'يجب أن يحدث دخول');
assert.equal(sm.inZone().length, 1);
ok('دخول عند provRSI < 7 (تنبيه فوري + إضافة للمنطقة)');

// سعر يبقي RSI بين 7 و10 (هنا ≈9.64) → بقاء (لا خروج).
engine.onKline({ exchange: 'binance', base: 'ADA', tf: '1h', symbol: 'ADAUSDT', closeTime: 2, closePrice: lastClose * 0.90, isClosed: false });
await tick();
assert.equal(sm.inZone().length, 1, 'يبقى داخل المنطقة في النطاق 7–10');
ok('بقاء داخل المنطقة دون رفرفة (hysteresis)');

// سعر يتعافى فوق العتبة → provRSI > 10 (هنا ≈15.4) → خروج
engine.onKline({ exchange: 'binance', base: 'ADA', tf: '1h', symbol: 'ADAUSDT', closeTime: 3, closePrice: lastClose * 0.95, isClosed: false });
await tick();
assert(events.some((e) => e[0] === 'exit' && e[1] === 'ADA'), 'يجب أن يحدث خروج');
assert.equal(sm.inZone().length, 0);
ok('خروج عند provRSI > 10 (حذف من المنطقة)');

// ── 4) أسهم الديجست (مقارنة بالتكرار السابق) ──
sm.zone.set('binance|AAA|1h', { exchange: 'binance', base: 'AAA', symbol: 'A', tf: '1h', entryRsi: 5, entryTime: new Date(), lastRsi: 4.2, prevDigestRsi: 6.0 });
sm.zone.set('binance|BBB|4h', { exchange: 'binance', base: 'BBB', symbol: 'B', tf: '4h', entryRsi: 6, entryTime: new Date(), lastRsi: 8.9, prevDigestRsi: 7.0 });
const dlines = await sm.buildDigestAndAdvance();
assert.equal(dlines.find((d) => d.base === 'AAA').arrow, '↓');
assert.equal(dlines.find((d) => d.base === 'BBB').arrow, '↑');
ok('أسهم الديجست: ↓ تتعمّق / ↑ تتعافى');

// ── 5) تقسيم الرسائل تحت 4096 ──
const many = Array.from({ length: 800 }, (_, i) => ({ exchange: 'binance', base: 'COIN' + i, tf: '1h', lastRsi: i % 10, arrow: '↓' }));
const chunks = splitChunks('🔴 H', many.map(renderDigestLine));
assert(chunks.length > 1, 'يجب أن يُقسَّم لأكثر من رسالة');
assert(chunks.every((c) => c.length <= 4096), 'كل قطعة تحت السقف');
assert(chunks.slice(0, -1).every((c) => /\+ \d+ أخرى/.test(c)), 'كل قطعة عدا الأخيرة فيها «+N أخرى»');
ok('التقسيم الإلزامي تحت 4096 مع «+N أخرى»');

const pinned = buildPinnedText(many.map((m) => ({ ...m, lastRsi: m.lastRsi })));
assert(pinned.length <= 4096);
ok('الرسالة المثبّتة تبقى تحت السقف');

console.log(`\n✅ نجحت كل الاختبارات (${pass})`);

function tick() { return new Promise((r) => setImmediate(r)); }
