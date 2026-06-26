import { config } from './config.js';
import { makeLogger } from './util/logger.js';

const log = makeLogger('scheduler');

/**
 * - نبضة الديجست: محاذاة على :00/:15/:30/:45.
 * - تحديث الرسالة المثبّتة: خفيف ومتكرّر (مع احترام الفاصل الأدنى في طبقة تيليجرام).
 * - الحارس: فحص دوري لإعادة ربط الستريمات الميتة.
 */
export class Scheduler {
  constructor({ stateMachine, telegram, adapters, onTick }) {
    this.sm = stateMachine;
    this.telegram = telegram;
    this.adapters = adapters;
    this.onTick = onTick;
    this.timers = [];
  }

  start() {
    this._scheduleDigest();

    // تحديث الرسالة المثبّتة كل 5ث (الطبقة تتجاهل لو لا تغيير/قبل الفاصل)
    this.timers.push(setInterval(() => {
      this.sm.maybeRefreshPinned().catch((e) => log.debug('pinned:', e.message));
    }, 5_000));

    // الحارس
    this.timers.push(setInterval(() => {
      for (const a of this.adapters) {
        try { a.watchdogSweep(); } catch (e) { log.debug('watchdog:', e.message); }
      }
    }, config.watchdogCheckMs));

    log.info('المجدول يعمل (ديجست محاذى + حارس)');
  }

  _msToNextQuarter() {
    const now = new Date();
    const ms = now.getMinutes() * 60_000 + now.getSeconds() * 1000 + now.getMilliseconds();
    const step = config.digestIntervalMin * 60_000;
    return step - (ms % step);
  }

  _scheduleDigest() {
    const wait = this._msToNextQuarter();
    log.info(`أول ديجست بعد ${Math.round(wait / 1000)}ث (محاذاة على الربع)`);
    this.timers.push(setTimeout(() => {
      this._runDigest();
      this.timers.push(setInterval(() => this._runDigest(), config.digestIntervalMin * 60_000));
    }, wait));
  }

  async _runDigest() {
    try {
      const lines = await this.sm.buildDigestAndAdvance();
      await this.telegram.sendDigest(lines);
      await this.sm.maybeRefreshPinned();
      if (this.onTick) await this.onTick();
      log.info(`ديجست أُرسِل (${lines.length} عنصر)`);
    } catch (e) {
      log.error('فشل الديجست:', e.message);
    }
  }

  stop() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
  }
}
