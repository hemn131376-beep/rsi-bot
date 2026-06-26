import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { makeLogger } from './util/logger.js';
import { MinIntervalGate } from './util/rateLimiter.js';
import { exName as ex, tfLabel as tfL, esc, buildPinnedText, splitChunks, renderZoneLine, renderDigestLine } from './format.js';

const log = makeLogger('telegram');

export class TelegramLayer {
  constructor({ db }) {
    this.db = db;
    this.chatId = config.telegramChatId;
    this.bot = new TelegramBot(config.telegramToken, { polling: true });
    this.pinnedId = null;
    this.pinGate = new MinIntervalGate(config.pinnedEditMinIntervalMs);
    this._lastPinnedText = '';
    this._statusProvider = null; // يُحقَن من index لأمر /status
    this._registerCommands();
  }

  setStatusProvider(fn) { this._statusProvider = fn; }
  setZoneProvider(fn) { this._zoneProvider = fn; }

  async send(text, opts = {}) {
    return this.bot.sendMessage(this.chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true, ...opts });
  }

  // ── 1) تنبيه دخول فوري ──
  async sendEntryAlert(item) {
    const t = `🔴 <b>دخول</b> | ${esc(item.base)} · ${ex(item.exchange)} · ${tfL(item.tf)} · RSI ${item.entryRsi.toFixed(1)}`;
    try { await this.send(t); } catch (e) { log.warn('فشل تنبيه الدخول:', e.message); }
  }

  // ── تنبيه خروج (اختياري) ──
  async sendExitAlert(item, rsi) {
    const t = `🟢 <b>خروج</b> | ${esc(item.base)} · ${ex(item.exchange)} · ${tfL(item.tf)} · RSI ${rsi.toFixed(1)}`;
    try { await this.send(t); } catch (e) { log.warn('فشل تنبيه الخروج:', e.message); }
  }

  // ── 2) الرسالة المثبّتة الحيّة ──
  async ensurePinned() {
    const saved = await this.db.getState('pinned_message_id');
    if (saved) { this.pinnedId = Number(saved); return; }
    const m = await this.send('🟡 جارٍ تهيئة المراقبة…');
    this.pinnedId = m.message_id;
    await this.db.setState('pinned_message_id', this.pinnedId);
    try { await this.bot.pinChatMessage(this.chatId, this.pinnedId, { disable_notification: true }); } catch (e) { log.warn('تعذّر التثبيت:', e.message); }
  }

  async refreshPinned(items) {
    if (!this.pinnedId) await this.ensurePinned();
    const text = buildPinnedText(items);
    if (text === this._lastPinnedText) return;     // لا تغيير فعلي
    if (!this.pinGate.ready()) return;             // احترام الفاصل الأدنى (سيلتقطه التحديث التالي)
    await this.pinGate.wait();
    try {
      await this.bot.editMessageText(text, { chat_id: this.chatId, message_id: this.pinnedId, parse_mode: 'HTML', disable_web_page_preview: true });
      this._lastPinnedText = text;
    } catch (e) {
      if (!/not modified/i.test(e.message)) log.warn('فشل تعديل المثبّتة:', e.message);
    }
  }

  // ── 3) ديجست كل 15 دقيقة ──
  async sendDigest(lines) {
    if (!lines.length) return; // لا شيء داخل المنطقة → لا ديجست
    const header = '🔴 <b>لا تزال في المنطقة (RSI &lt; 10)</b>';
    const rendered = lines.map(renderDigestLine);
    for (const text of splitChunks(header, rendered)) {
      try { await this.send(text); } catch (e) { log.warn('فشل إرسال الديجست:', e.message); }
    }
  }

  // ── 5) الأوامر ──
  _registerCommands() {
    this.bot.onText(/^\/list/, async (msg) => {
      if (String(msg.chat.id) !== String(this.chatId)) return;
      const items = this._zoneProvider ? this._zoneProvider() : [];
      const sorted = items.slice().sort((a, b) => a.lastRsi - b.lastRsi);
      if (!sorted.length) return this.send('⚪️ لا توجد عملات داخل المنطقة الآن.');
      const rendered = sorted.map(renderZoneLine);
      for (const text of splitChunks('📋 <b>المنطقة الآن</b>', rendered)) await this.send(text);
    });

    this.bot.onText(/^\/status/, async (msg) => {
      if (String(msg.chat.id) !== String(this.chatId)) return;
      const s = this._statusProvider ? await this._statusProvider() : null;
      if (!s) return this.send('الحالة غير متاحة بعد.');
      const lines = [];
      lines.push(`⏱️ التشغيل: ${s.uptime}`);
      lines.push(`📡 الستريمات الحيّة لكل منصة:`);
      for (const h of s.health) lines.push(`   • ${ex(h.exchange)}: ${h.liveConnections}/${h.connections} اتصال · ${h.subscriptions} اشتراك`);
      lines.push(`🔴 داخل المنطقة: ${s.inZone}`);
      lines.push(`🔁 آخر إعادة اتصال: ${s.lastReconnect ?? '—'}`);
      lines.push(`🧮 مفاتيح RSI: ${s.keys}`);
      if (s.unmonitored?.length) {
        lines.push(`🚫 غير مراقَب (${s.unmonitored.length}): ${s.unmonitored.slice(0, 30).join(', ')}${s.unmonitored.length > 30 ? ' …' : ''}`);
      } else {
        lines.push('🚫 غير مراقَب: لا شيء');
      }
      await this.send(lines.join('\n'));
    });

    this.bot.on('polling_error', (e) => log.debug('polling_error:', e.message));
  }
}
