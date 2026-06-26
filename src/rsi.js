/**
 * مؤشّر RSI بتنعيم Wilder، محسوب لحظياً على الشمعة المفتوحة.
 *
 * الحالة المثبّتة = { avgGain, avgLoss, lastClose } مبنيّة من الشموع المغلقة.
 * provisional(livePrice) يحسب RSI مؤقتاً دون تعديل الحالة.
 * commit(closePrice) يثبّت الحالة عند إغلاق الشمعة.
 */
export class WilderRSI {
  constructor(period = 14) {
    this.period = period;
    this.avgGain = null;
    this.avgLoss = null;
    this.lastClose = null;
    this.ready = false;
  }

  /**
   * تهيئة من مصفوفة أسعار إغلاق مرتّبة زمنياً (الأقدم أولاً).
   * نحتاج على الأقل period+1 سعراً.
   */
  seed(closes) {
    if (!Array.isArray(closes) || closes.length < this.period + 1) {
      throw new Error(`seed يحتاج ${this.period + 1} شمعة على الأقل، وصل ${closes?.length ?? 0}`);
    }
    const p = this.period;
    let gainSum = 0;
    let lossSum = 0;
    // أول period فرق
    for (let i = 1; i <= p; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gainSum += d;
      else lossSum += -d;
    }
    let avgGain = gainSum / p;
    let avgLoss = lossSum / p;
    // تنعيم Wilder عبر بقيّة الشموع المغلقة
    for (let i = p + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const gain = d > 0 ? d : 0;
      const loss = d < 0 ? -d : 0;
      avgGain = (avgGain * (p - 1) + gain) / p;
      avgLoss = (avgLoss * (p - 1) + loss) / p;
    }
    this.avgGain = avgGain;
    this.avgLoss = avgLoss;
    this.lastClose = closes[closes.length - 1];
    this.ready = true;
    return this;
  }

  static _rsiFrom(g, l) {
    if (l === 0) return g === 0 ? 50 : 100; // لا خسائر → مشبع شراء
    const rs = g / l;
    return 100 - 100 / (1 + rs);
  }

  /**
   * RSI المؤقت لسعر حيّ على الشمعة المفتوحة — لا يعدّل الحالة.
   */
  provisional(livePrice) {
    if (!this.ready) return null;
    const p = this.period;
    const delta = livePrice - this.lastClose;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    const g = (this.avgGain * (p - 1) + gain) / p;
    const l = (this.avgLoss * (p - 1) + loss) / p;
    return WilderRSI._rsiFrom(g, l);
  }

  /**
   * تثبيت الحالة عند إغلاق شمعة بسعر إغلاق نهائي.
   */
  commit(closePrice) {
    if (!this.ready) return;
    const p = this.period;
    const delta = closePrice - this.lastClose;
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    this.avgGain = (this.avgGain * (p - 1) + gain) / p;
    this.avgLoss = (this.avgLoss * (p - 1) + loss) / p;
    this.lastClose = closePrice;
  }
}
