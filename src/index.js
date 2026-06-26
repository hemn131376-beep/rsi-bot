import { config, assertConfig } from './config.js';
import { makeLogger } from './util/logger.js';
import { loadWhitelist } from './whitelist.js';
import { buildRouting } from './router.js';
import { ADAPTERS } from './exchanges/index.js';
import { Engine } from './engine.js';
import { StateMachine } from './stateMachine.js';
import { TelegramLayer } from './telegram.js';
import { Db } from './db.js';
import { Scheduler } from './scheduler.js';
import { PacedQueue } from './util/rateLimiter.js';

const log = makeLogger('index');
const startedAt = Date.now();
let lastReconnect = null;

function uptimeStr() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return `${d ? d + 'ي ' : ''}${h}س ${m}د`;
}

async function main() {
  assertConfig();
  log.info('=== إقلاع بوت مراقبة RSI (قائمة الحلال) ===');

  // (1) قاعدة البيانات
  const db = new Db();
  await db.init();

  // (2) طبقة تيليجرام (تبدأ polling للأوامر فوراً)
  const telegram = new TelegramLayer({ db });

  // (3) القائمة المغلقة
  const whitelist = await loadWhitelist();

  // (4) الـRouter: استعلام أدوات كل منصة حيّاً + إسناد + سيولة + أولوية الزوج
  const { routing, unmonitored, dist } = await buildRouting(whitelist);
  await db.saveRouting(routing).catch((e) => log.warn('حفظ التوجيه فشل:', e.message));

  // (5) المحرّك + آلة الحالة
  const engine = new Engine();
  const stateMachine = new StateMachine({ db, telegram });
  engine.on('rsi', (ev) => stateMachine.onRsi(ev).catch((e) => log.debug('onRsi:', e.message)));

  // وفّر مزوّدات الأوامر
  telegram.setZoneProvider(() => stateMachine.inZone());

  // (6) جهّز محوّلات المنصّات وقوائم الاشتراك
  const byExchange = groupBy(routing, (r) => r.exchange);
  const adapters = [];
  const adapterByName = {};

  for (const name of config.cascade) {
    const list = byExchange.get(name);
    if (!list || !list.length) continue;
    const adapter = new ADAPTERS[name]();
    adapterByName[name] = adapter;
    adapters.push(adapter);

    // عناصر الاشتراك = حاصل ضرب الأزواج × الفريمات
    const items = [];
    for (const r of list) for (const tf of config.timeframes) items.push({ symbol: r.symbol, base: r.base, tf });
    adapter._items = items;

    // المحرّك يستقبل الأحداث الموحّدة
    adapter.on('kline', (ev) => engine.onKline(ev));

    // إعادة البذر قبل استئناف البثّ بعد أي انقطاع
    adapter.onReseed = async (shardItems) => {
      lastReconnect = new Date().toISOString();
      await engine.reseed(name, shardItems, (sym, tf) => adapter.seed(sym, tf));
    };
  }

  // (5-bis) استرجاع المنطقة + pinned من DB، وتثبيت الرسالة
  await stateMachine.hydrate();
  await telegram.ensurePinned();
  await telegram.refreshPinned(stateMachine.sortedZone());

  // (3-bis) بذر الشموع عبر REST بطابور متحكَّم بالمعدّل (لكل منصة بالتوازي، داخلياً متسلسل)
  log.info('بدء البذر عبر REST (قد يستغرق دقائق حسب العدد)…');
  await Promise.all(
    Object.entries(adapterByName).map(([name, adapter]) => seedExchange(name, adapter, engine)),
  );
  log.info(`اكتمل البذر — مفاتيح RSI: ${engine.stats().keys}`);

  // (4-bis) فتح اتصالات WS المشرذمة والاشتراك
  for (const [name, adapter] of Object.entries(adapterByName)) {
    await adapter.subscribe(adapter._items);
  }

  // (6) المجدول: نبضة الديجست + الحارس
  const scheduler = new Scheduler({ stateMachine, telegram, adapters });
  scheduler.start();

  // مزوّد /status
  telegram.setStatusProvider(async () => ({
    uptime: uptimeStr(),
    health: adapters.map((a) => a.health()),
    inZone: stateMachine.inZone().length,
    keys: engine.stats().keys,
    lastReconnect,
    unmonitored: unmonitored.map((u) => u.base),
  }));

  log.info(`=== جاهز. مراقَب: ${routing.length} زوج عبر ${Object.keys(dist).length} منصة · غير مراقَب: ${unmonitored.length} ===`);

  // إيقاف نظيف
  const shutdown = () => {
    log.info('إيقاف…');
    scheduler.stop();
    for (const a of adapters) a.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** بذر كل أزواج منصة عبر REST بطابور متحكَّم بالمعدّل. */
async function seedExchange(name, adapter, engine) {
  const q = new PacedQueue(config.seedDelayMs);
  let ok = 0, fail = 0;
  await Promise.all(
    adapter._items.map((it) =>
      q.add(async () => {
        try {
          const closes = await adapter.seed(it.symbol, it.tf);
          engine.seedKey({ exchange: name, base: it.base, tf: it.tf, symbol: it.symbol }, closes);
          ok++;
        } catch (err) {
          fail++;
          if (fail <= 5) log.debug(`بذر فشل ${name} ${it.symbol} ${it.tf}: ${err.message}`);
        }
      }),
    ),
  );
  log.info(`بذر ${name}: ${ok} نجح، ${fail} فشل`);
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

main().catch((err) => {
  log.error('فشل قاتل في الإقلاع:', err.stack || err.message);
  process.exit(1);
});
