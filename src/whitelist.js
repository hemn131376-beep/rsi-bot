import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import { makeLogger } from './util/logger.js';

const log = makeLogger('whitelist');

/**
 * تحميل القائمة المغلقة (halal_whitelist.csv) → مصفوفة رموز base فريدة بأحرف كبيرة.
 *
 * يتقبّل:
 *  - عمود واحد فيه الرمز.
 *  - عدّة أعمدة مع ترويسة فيها أحد: base / symbol / asset / coin / ticker.
 *  - أسطر بفواصل (,) أو فاصلة منقوطة (;).
 * يتجاهل السطر الفارغ وأسطر التعليق التي تبدأ بـ #.
 */
export async function loadWhitelist(path = config.whitelistPath) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new Error(`تعذّر قراءة قائمة الحلال من ${path}: ${err.message}`);
  }

  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length && !l.startsWith('#'));

  if (!lines.length) throw new Error('قائمة الحلال فارغة');

  const split = (l) => l.split(/[,;]\s*/).map((c) => c.trim());

  // كشف الترويسة
  const header = split(lines[0]).map((c) => c.toLowerCase());
  const nameCols = ['base', 'symbol', 'asset', 'coin', 'ticker'];
  let startIdx = 0;
  let col = 0;
  const hit = header.findIndex((h) => nameCols.includes(h));
  if (hit !== -1) {
    startIdx = 1;
    col = hit;
  }

  const set = new Set();
  for (let i = startIdx; i < lines.length; i++) {
    const cells = split(lines[i]);
    let base = (cells[col] ?? cells[0] ?? '').toUpperCase();
    // إزالة لاحقة الزوج لو وُجدت بالغلط (مثل ADAUSDT → ADA)
    base = base.replace(/(USDT|USDC|BTC)$/i, (m, _g, off, s) => (s.length > m.length ? '' : m));
    base = base.replace(/[^A-Z0-9]/g, '');
    if (base) set.add(base);
  }

  const bases = [...set];
  log.info(`حُمِّل ${bases.length} رمزاً من القائمة المغلقة`);
  return bases;
}
