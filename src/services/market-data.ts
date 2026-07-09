/**
 * NovaBit Exchange — Market Data Service
 *
 * Provides kline/candlestick data by proxying to Binance's public API.
 * Also provides WebSocket feed helpers for real-time data.
 */

import { KlineData, KlineInterval, INTERVAL_MAP } from '../schemas/market.js';

const BINANCE_BASE = 'https://api.binance.com';

export class MarketDataService {
  /**
   * Fetch kline/candlestick data from Binance's public API.
   * Maps our interval names to Binance's format.
   */
  async getKlines(
    symbol: string,
    interval: KlineInterval = '1h',
    limit: number = 200,
  ): Promise<KlineData[]> {
    const binanceInterval = INTERVAL_MAP[interval] || interval;
    const url = `${BINANCE_BASE}/api/v3/klines?symbol=${symbol.toUpperCase()}&interval=${binanceInterval}&limit=${limit}`;

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      // Fallback: return mock data for development
      return this.generateMockKlines(symbol, interval, limit);
    }

    if (!response.ok) {
      // Fallback to mock data on error
      return this.generateMockKlines(symbol, interval, limit);
    }

    const data = await response.json() as unknown[][];

    return data.map((k: unknown[]) => ({
      time: Math.floor(Number(k[0]) / 1000), // Binance returns ms timestamps
      open: String(k[1]),
      high: String(k[2]),
      low: String(k[3]),
      close: String(k[4]),
      volume: String(k[5]),
    }));
  }

  /**
   * Generate mock kline data for development/demo purposes.
   * Uses a deterministic pattern based on the pair and time.
   */
  private generateMockKlines(
    symbol: string,
    interval: string,
    limit: number,
  ): KlineData[] {
    const now = Math.floor(Date.now() / 1000);
    const intervalSeconds = this.getIntervalSeconds(interval);
    const basePrice = this.getBasePrice(symbol);
    const data: KlineData[] = [];

    for (let i = limit - 1; i >= 0; i--) {
      const time = now - (i * intervalSeconds);
      const seed = Math.sin(time * 0.001 + symbol.length) * 100;
      const volatility = basePrice * 0.02; // 2% volatility
      const open = basePrice + (seed % volatility);
      const close = open + (Math.sin(time * 0.002) * volatility * 0.5);
      const high = Math.max(open, close) + Math.abs(seed % (volatility * 0.3));
      const low = Math.min(open, close) - Math.abs(seed % (volatility * 0.3));
      const volume = 10 + Math.abs(seed % 90);

      data.push({
        time,
        open: open.toFixed(2),
        high: high.toFixed(2),
        low: low.toFixed(2),
        close: close.toFixed(2),
        volume: volume.toFixed(4),
      });
    }

    return data;
  }

  private getIntervalSeconds(interval: string): number {
    const map: Record<string, number> = {
      '1m': 60,
      '5m': 300,
      '15m': 900,
      '30m': 1800,
      '1h': 3600,
      '4h': 14400,
      '1d': 86400,
      '1w': 604800,
      '1M': 2592000,
    };
    return map[interval] || 3600;
  }

  private getBasePrice(symbol: string): number {
    const prices: Record<string, number> = {
      BTCUSDT: 65000,
      ETHUSDT: 3500,
      SOLUSDT: 145,
      ADAUSDT: 0.45,
      DOTUSDT: 7.2,
      AVAXUSDT: 35,
      LINKUSDT: 14,
      UNIUSDT: 8,
      MATICUSDT: 0.7,
      ATOMUSDT: 9,
    };
    return prices[symbol.toUpperCase()] || 100;
  }
}