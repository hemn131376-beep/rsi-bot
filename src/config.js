import 'dotenv/config';

/**
 * كل القرارات المثبّتة في المخطط النهائي موضوعة هنا في مكان واحد.
 * تعديلها يعدّل سلوك النظام دون لمس بقيّة الوحدات.
 */
export const config = {
  // ── مؤشّر RSI ───────────────────────────────────────────────
  rsiPeriod: 14,          // فترة Wilder
  seedCandles: 150,       // كم شمعة مغلقة نسحب للتهيئة

  // ── العتبات (hysteresis) ────────────────────────────────────
  entryThreshold: 7,      // provRSI < 7  → دخول المنطقة + تنبيه فوري
  exitThreshold: 10,      // provRSI > 10 → خروج من المنطقة + حذف
  // الفجوة 7↔10 تمنع الرفرفة على الحدّ

  // ── الفريمات (canonical) ────────────────────────────────────
  timeframes: ['1h', '4h', '1d', '1w'],

  // ── الديجست ─────────────────────────────────────────────────
  digestIntervalMin: 15,  // محاذاة على :00/:15/:30/:45

  // ── الموثوقية ───────────────────────────────────────────────
  watchdogTimeoutMs: 90_000,   // ستريم صامت أطول من هذا = ميت
  watchdogCheckMs: 20_000,     // كل كم نفحص الحارس
  reconnectBaseMs: 1_000,      // backoff تصاعدي
  reconnectMaxMs: 60_000,

  // ── فلتر السيولة ────────────────────────────────────────────
  minVolumeUsd: Number(process.env.MIN_VOLUME_USD ?? 75_000), // حجم 24س أدنى

  // ── أولوية الزوج وتدرّج المنصّات ─────────────────────────────
  quotePriority: ['USDT', 'USDC', 'BTC'],
  cascade: ['binance', 'okx', 'kucoin', 'mexc'],

  // ── ضبط معدّل بذر REST (ms بين الطلبات لكل منصة) ────────────
  seedDelayMs: Number(process.env.SEED_DELAY_MS ?? 150),

  // ── تيليجرام ────────────────────────────────────────────────
  pinnedEditMinIntervalMs: 3_000, // أدنى فاصل بين تعديلات الرسالة المثبّتة (تفادي 429)
  sendExitAlert: true,            // تنبيه خروج اختياري
  maxMessageLen: 4096,            // سقف تيليجرام

  // ── المصادر والأسرار ────────────────────────────────────────
  whitelistPath: process.env.WHITELIST_PATH ?? 'data/halal_whitelist.csv',
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramChatId: process.env.TELEGRAM_CHAT_ID,
  databaseUrl: process.env.DATABASE_URL,

  // تشغيل بدون قاعدة بيانات (للتجربة المحليّة فقط)
  noDb: process.env.NO_DB === '1',
};

export function assertConfig() {
  const missing = [];
  if (!config.telegramToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!config.telegramChatId) missing.push('TELEGRAM_CHAT_ID');
  if (!config.databaseUrl && !config.noDb) missing.push('DATABASE_URL');
  if (missing.length) {
    throw new Error(`متغيّرات بيئة ناقصة: ${missing.join(', ')}`);
  }
}
