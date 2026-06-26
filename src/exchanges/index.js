import { BinanceAdapter } from './binance.js';
import { OKXAdapter } from './okx.js';
import { KuCoinAdapter } from './kucoin.js';
import { MexcAdapter } from './mexc.js';

export const ADAPTERS = {
  binance: BinanceAdapter,
  okx: OKXAdapter,
  kucoin: KuCoinAdapter,
  mexc: MexcAdapter,
};

export { BinanceAdapter, OKXAdapter, KuCoinAdapter, MexcAdapter };
