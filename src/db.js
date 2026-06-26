import pg from 'pg';
import { config } from './config.js';
import { makeLogger } from './util/logger.js';

const log = makeLogger('db');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS monitored_zone (
  exchange          TEXT NOT NULL,
  base              TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  tf                TEXT NOT NULL,
  entry_rsi         DOUBLE PRECISION,
  entry_time        TIMESTAMPTZ,
  last_reported_rsi DOUBLE PRECISION,
  last_report_time  TIMESTAMPTZ,
  PRIMARY KEY (exchange, base, tf)
);
CREATE TABLE IF NOT EXISTS bot_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS coin_routing (
  base     TEXT PRIMARY KEY,
  exchange TEXT,
  symbol   TEXT,
  quote    TEXT
);
`;

/** واجهة موحّدة؛ في وضع noDb نستعمل ذاكرة فقط (للتجربة). */
export class Db {
  constructor() {
    this.noDb = config.noDb || !config.databaseUrl;
    this._mem = { zone: new Map(), state: new Map(), routing: new Map() };
    this.pool = null;
  }

  async init() {
    if (this.noDb) {
      log.warn('وضع بلا قاعدة بيانات (NO_DB) — الحالة في الذاكرة فقط، لا تنجو من إعادة التشغيل');
      return;
    }
    this.pool = new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: config.databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false },
      max: 5,
    });
    await this.pool.query(SCHEMA);
    log.info('Postgres جاهزة والمخطط مُهيّأ');
  }

  // ── monitored_zone ──
  async loadZone() {
    if (this.noDb) return [...this._mem.zone.values()];
    const { rows } = await this.pool.query('SELECT * FROM monitored_zone');
    return rows;
  }

  async upsertZone(item) {
    const key = `${item.exchange}|${item.base}|${item.tf}`;
    if (this.noDb) {
      this._mem.zone.set(key, {
        exchange: item.exchange, base: item.base, symbol: item.symbol, tf: item.tf,
        entry_rsi: item.entryRsi, entry_time: item.entryTime,
        last_reported_rsi: item.lastRsi ?? item.entryRsi, last_report_time: new Date(),
      });
      return;
    }
    await this.pool.query(
      `INSERT INTO monitored_zone (exchange, base, symbol, tf, entry_rsi, entry_time, last_reported_rsi, last_report_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())
       ON CONFLICT (exchange, base, tf) DO UPDATE SET symbol=EXCLUDED.symbol`,
      [item.exchange, item.base, item.symbol, item.tf, item.entryRsi, item.entryTime, item.lastRsi ?? item.entryRsi],
    );
  }

  async deleteZone(key) {
    const [exchange, base, tf] = key.split('|');
    if (this.noDb) { this._mem.zone.delete(key); return; }
    await this.pool.query('DELETE FROM monitored_zone WHERE exchange=$1 AND base=$2 AND tf=$3', [exchange, base, tf]);
  }

  async updateReported(key, rsi) {
    const [exchange, base, tf] = key.split('|');
    if (this.noDb) {
      const z = this._mem.zone.get(key);
      if (z) { z.last_reported_rsi = rsi; z.last_report_time = new Date(); }
      return;
    }
    await this.pool.query(
      'UPDATE monitored_zone SET last_reported_rsi=$4, last_report_time=now() WHERE exchange=$1 AND base=$2 AND tf=$3',
      [exchange, base, tf, rsi],
    );
  }

  // ── bot_state ──
  async getState(key) {
    if (this.noDb) return this._mem.state.get(key) ?? null;
    const { rows } = await this.pool.query('SELECT value FROM bot_state WHERE key=$1', [key]);
    return rows[0]?.value ?? null;
  }

  async setState(key, value) {
    if (this.noDb) { this._mem.state.set(key, String(value)); return; }
    await this.pool.query(
      'INSERT INTO bot_state (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value',
      [key, String(value)],
    );
  }

  // ── coin_routing ──
  async saveRouting(routing) {
    if (this.noDb) {
      for (const r of routing) this._mem.routing.set(r.base, r);
      return;
    }
    // كتابة دفعيّة بسيطة
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('TRUNCATE coin_routing');
      for (const r of routing) {
        await client.query(
          'INSERT INTO coin_routing (base, exchange, symbol, quote) VALUES ($1,$2,$3,$4) ON CONFLICT (base) DO UPDATE SET exchange=EXCLUDED.exchange, symbol=EXCLUDED.symbol, quote=EXCLUDED.quote',
          [r.base, r.exchange, r.symbol, r.quote],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
}
