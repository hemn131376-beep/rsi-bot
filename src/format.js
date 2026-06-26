import { config } from './config.js';

export const exName = (e) => ({ binance: 'Binance', okx: 'OKX', kucoin: 'KuCoin', mexc: 'MEXC' }[e] || e);
export const tfLabel = (t) => String(t).toUpperCase();
export const esc = (s) => String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));

export const renderZoneLine = (it) =>
  `${esc(it.base)} · ${exName(it.exchange)} · ${tfLabel(it.tf)} · ${Number(it.lastRsi).toFixed(1)}`;

export const renderDigestLine = (it) =>
  `${esc(it.base)} · ${exName(it.exchange)} · ${tfLabel(it.tf)} · ${Number(it.lastRsi).toFixed(1)} ${it.arrow}`;

export function buildPinnedText(items, maxLen = config.maxMessageLen) {
  if (!items.length) return '⚪️ لا توجد عملات داخل المنطقة حالياً (RSI &lt; 10).';
  const head = `🔴 <b>داخل المنطقة (RSI &lt; 10)</b> — ${items.length}\n`;
  const cap = 60;
  const lines = items.slice(0, cap).map(renderZoneLine);
  let body = lines.join('\n');
  if (items.length > cap) body += `\n+ ${items.length - cap} أخرى`;
  let text = head + body;
  if (text.length > maxLen) text = text.slice(0, maxLen - 12) + '\n…';
  return text;
}

/**
 * تقسيم إلزامي تحت سقف تيليجرام مع «+N أخرى» لكل قطعة.
 * يُرجِع مصفوفة نصوص جاهزة للإرسال.
 */
export function splitChunks(header, rendered, maxLen = config.maxMessageLen) {
  const limit = maxLen - 64;
  const out = [];
  let i = 0;
  let part = 0;
  while (i < rendered.length) {
    const chunk = [];
    let len = header.length + 1;
    while (i < rendered.length && len + rendered[i].length + 1 < limit) {
      len += rendered[i].length + 1;
      chunk.push(rendered[i]);
      i++;
    }
    // ضمان تقدّم حتى لو سطر واحد أطول من الحدّ (نادر)
    if (chunk.length === 0) { chunk.push(rendered[i].slice(0, limit - header.length - 8) + '…'); i++; }
    const remaining = rendered.length - i;
    let text = `${header}${part > 0 ? ` (تتمّة ${part + 1})` : ''}\n` + chunk.join('\n');
    if (remaining > 0) text += `\n+ ${remaining} أخرى`;
    out.push(text);
    part++;
  }
  return out;
}
