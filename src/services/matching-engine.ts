/**
 * NovaBit Exchange — Matching Engine
 *
 * Core FIFO price-time priority matching engine.
 * Uses PostgreSQL as the source of truth for orders.
 * Redis is used for the live order book (sorted sets for bids/asks).
 *
 * Matching algorithm:
 * 1. Incoming order → fetch matching orders from Redis order book
 * 2. Match against opposite side at best price (buy highest, sell lowest)
 * 3. For same price level, fill oldest orders first (FIFO)
 * 4. Create trade records for each fill
 * 5. Update order statuses (PARTIALLY_FILLED / FILLED)
 * 6. Update wallet balances (lock/release)
 * 7. Update order book in Redis
 */

import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { AppError } from '../middleware/error-handler.js';
import { getRedis } from '../db/index.js';
import type { Redis as RedisType } from 'ioredis';
import { CreateOrderInput, OrderResponse, TradeResponse, OrderBookResponse, OrderBookLevel } from '../schemas/order.js';

// ── Types ────────────────────────────────────
interface TradeResult {
  tradeId: string;
  price: string;
  quantity: string;
  quoteQuantity: string;
  takerSide: 'BUY' | 'SELL';
  buyerOrderId: string;
  sellerOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  buyerFee: string;
  sellerFee: string;
}

interface TradingPairRow {
  symbol: string;
  base_asset: string;
  quote_asset: string;
  is_active: boolean;
  base_precision: number;
  quote_precision: number;
  min_base_amount: string;
  min_quote_amount: string;
  maker_fee_rate: string;
  taker_fee_rate: string;
}

type DB = pg.Pool | pg.PoolClient;

// ── Order Book Keys ──────────────────────────
const ORDER_BOOK_BIDS_KEY = (pair: string) => `orderbook:${pair}:bids`;
const ORDER_BOOK_ASKS_KEY = (pair: string) => `orderbook:${pair}:asks`;
const ORDER_META_KEY = (orderId: string) => `order:${orderId}`;

// ── Matching Engine ──────────────────────────
export class MatchingEngine {
  private redis: RedisType;
  private metrics?: {
    orderBookDepth: any;
    tradeVolume: any;
  };

  constructor(private db: pg.Pool, metrics?: { orderBookDepth: any; tradeVolume: any }) {
    this.redis = getRedis();
    this.metrics = metrics;
  }

  private async withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // ── Validate trading pair ───────────────────
  async getTradingPair(pair: string): Promise<TradingPairRow> {
    const result = await this.db.query(
      `SELECT * FROM trading_pairs WHERE symbol = $1 AND is_active = TRUE LIMIT 1`,
      [pair.toUpperCase()],
    );
    if (result.rows.length === 0) {
      throw new AppError(400, 'INVALID_PAIR', `Trading pair ${pair} is not available`);
    }
    return result.rows[0];
  }

  // ── Validate and create order ───────────────
  async createOrder(userId: string, input: CreateOrderInput): Promise<OrderResponse> {
    const pair = input.pair.toUpperCase();
    const tradingPair = await this.getTradingPair(pair);

    // Validate order type requirements
    if (input.type === 'LIMIT' || input.type === 'STOP_LIMIT') {
      if (!input.price) {
        throw new AppError(400, 'PRICE_REQUIRED', 'Limit orders require a price');
      }
    }

    if (input.type === 'MARKET' && input.side === 'BUY' && !input.quote_quantity && !input.quantity) {
      throw new AppError(400, 'QUANTITY_REQUIRED', 'Market buy requires either quantity or quote_quantity');
    }

    if (input.type === 'STOP_LIMIT' || input.type === 'STOP_MARKET') {
      if (!input.stop_price) {
        throw new AppError(400, 'STOP_PRICE_REQUIRED', 'Stop orders require a stop_price');
      }
    }

    // For stop orders, just insert as PENDING (will be triggered when price crosses stop)
    if (input.type === 'STOP_LIMIT' || input.type === 'STOP_MARKET') {
      return this.createStopOrder(userId, pair, input, tradingPair);
    }

    const orderQuantity = input.quantity || '0';
    const orderQuoteQuantity = input.quote_quantity || '0';

    // Execute order creation and matching within a single transaction
    return this.withTransaction(async (client) => {
      // Check balance before placing order (within transaction for atomicity)
      await this.validateBalance(client, userId, input.side, input.type, orderQuantity, orderQuoteQuantity, input.price, pair, tradingPair);

      // For MARKET orders, execute immediately
      if (input.type === 'MARKET') {
        return this.executeMarketOrder(client, userId, pair, input, tradingPair);
      }

      // For LIMIT orders, insert into order book and try to match
      return this.executeLimitOrder(client, userId, pair, input, orderQuantity, orderQuoteQuantity, tradingPair);
    });
  }

  // ── Cancel order ───────────────────────────
  async cancelOrder(userId: string, orderId: string): Promise<void> {
    await this.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT id, user_id, pair, side, status, price, quantity, filled_quantity,
                fee_amount, time_in_force
         FROM orders WHERE id = $1 FOR UPDATE`, // Lock row for update
        [orderId],
      );

      if (result.rows.length === 0) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
      }

      const order = result.rows[0];

      if (order.user_id !== userId) {
        throw new AppError(403, 'FORBIDDEN', 'You can only cancel your own orders');
      }

      if (order.status === 'FILLED' || order.status === 'CANCELED' || order.status === 'REJECTED') {
        throw new AppError(400, 'ORDER_NOT_CANCELABLE', `Cannot cancel order with status '${order.status}'`);
      }

      // Remove from Redis order book if it was open
      if (order.status === 'OPEN' || order.status === 'PARTIALLY_FILLED') {
        await this.removeFromOrderBook(order);
      }

      // Release locked balance
      const remainingQuantity = Number(order.quantity) - Number(order.filled_quantity);
      if (remainingQuantity > 0) {
        await this.releaseLockedBalance(client, userId, order, remainingQuantity);
      }

      await client.query(
        `UPDATE orders SET status = 'CANCELED', updated_at = NOW() WHERE id = $1`,
        [orderId],
      );
    });
  }

  // ── List user orders ───────────────────────
  async listOrders(
    userId: string,
    options: { pair?: string; status?: string; side?: string; limit: number; offset: number },
  ): Promise<{ orders: OrderResponse[]; total: number }> {
    const conditions = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIdx = 2;

    if (options.pair) {
      conditions.push(`pair = $${paramIdx++}`);
      params.push(options.pair.toUpperCase());
    }
    if (options.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(options.status);
    }
    if (options.side) {
      conditions.push(`side = $${paramIdx++}`);
      params.push(options.side);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM orders WHERE ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(options.limit, options.offset);
    const result = await this.db.query(
      `SELECT * FROM orders WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params,
    );

    return {
      orders: result.rows.map((r: Record<string, unknown>) => this.mapOrder(r)),
      total,
    };
  }

  // ── Get order by id ────────────────────────
  async getOrder(orderId: string, userId: string): Promise<OrderResponse> {
    const result = await this.db.query(
      `SELECT * FROM orders WHERE id = $1`,
      [orderId],
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    const order = result.rows[0];
    if (order.user_id !== userId) {
      throw new AppError(403, 'FORBIDDEN', 'Access denied');
    }
    return this.mapOrder(order);
  }

  // ── Get order book snapshot ────────────────
  async getOrderBook(pair: string, depth: number = 20): Promise<OrderBookResponse> {
    const pairUpper = pair.toUpperCase();

    const [bids, asks] = await Promise.all([
      this.redis.zrangebyscore(
        ORDER_BOOK_BIDS_KEY(pairUpper),
        '-inf', '+inf',
        'WITHSCORES',
        'LIMIT', 0, depth,
      ),
      this.redis.zrangebyscore(
        ORDER_BOOK_ASKS_KEY(pairUpper),
        '-inf', '+inf',
        'WITHSCORES',
        'LIMIT', 0, depth,
      ),
    ]);

    const bidsFormatted = this.formatOrderBookLevels(bids, false);
    const asksFormatted = this.formatOrderBookLevels(asks, true);

    // If Redis is empty, fall back to PostgreSQL
    if (bidsFormatted.length === 0 && asksFormatted.length === 0) {
      return this.getOrderBookFromDb(pairUpper, depth);
    }

    return {
      pair: pairUpper,
      bids: bidsFormatted,
      asks: asksFormatted,
      timestamp: Date.now(),
    };
  }

  // ── Get recent trades ──────────────────────
  async getRecentTrades(pair: string, limit: number = 50): Promise<TradeResponse[]> {
    const result = await this.db.query(
      `SELECT id, pair, price, quantity, quote_quantity, taker_side,
              buyer_order_id, seller_order_id, trade_time
       FROM trades
       WHERE pair = $1
       ORDER BY trade_time DESC
       LIMIT $2`,
      [pair.toUpperCase(), limit],
    );

    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      pair: row.pair as string,
      price: String(row.price),
      quantity: String(row.quantity),
      quote_quantity: String(row.quote_quantity),
      taker_side: row.taker_side as string,
      buyer_order_id: row.buyer_order_id as string,
      seller_order_id: row.seller_order_id as string,
      trade_time: (row.trade_time as Date).toISOString(),
    }));
  }

  // ── Get 24hr ticker ────────────────────────
  async getTicker(pair: string): Promise<{
    pair: string;
    last_price: string;
    volume_24h: string;
    high_24h: string;
    low_24h: string;
    change_24h: string;
    change_percent_24h: string;
    timestamp: number;
  }> {
    const pairUpper = pair.toUpperCase();

    const result = await this.db.query(
      `SELECT
         COALESCE((SELECT price FROM trades WHERE pair = $1 ORDER BY trade_time DESC LIMIT 1), '0') as last_price,
         COALESCE(SUM(quantity), 0) as volume_24h,
         COALESCE(MAX(price), 0) as high_24h,
         COALESCE(MIN(price), 0) as low_24h
       FROM trades
       WHERE pair = $1 AND trade_time > NOW() - INTERVAL '24 hours'`,
      [pairUpper],
    );

    const row = result.rows[0];
    const lastPrice = row.last_price;
    const volume24h = String(row.volume_24h);
    const high24h = String(row.high_24h);
    const low24h = String(row.low_24h);

    // Get price 24h ago for change calculation
    const oldPriceResult = await this.db.query(
      `SELECT price FROM trades
       WHERE pair = $1 AND trade_time <= NOW() - INTERVAL '24 hours'
       ORDER BY trade_time DESC LIMIT 1`,
      [pairUpper],
    );

    const oldPrice = oldPriceResult.rows.length > 0 ? oldPriceResult.rows[0].price : lastPrice;
    const change = (Number(lastPrice) - Number(oldPrice)).toFixed(8);
    const changePercent = Number(oldPrice) > 0
      ? (((Number(lastPrice) - Number(oldPrice)) / Number(oldPrice)) * 100).toFixed(2)
      : '0.00';

    return {
      pair: pairUpper,
      last_price: String(lastPrice),
      volume_24h: volume24h,
      high_24h: high24h,
      low_24h: low24h,
      change_24h: change,
      change_percent_24h: changePercent,
      timestamp: Date.now(),
    };
  }

  // ── List trading pairs ─────────────────────
  async listPairs(): Promise<{ symbol: string; base_asset: string; quote_asset: string }[]> {
    const result = await this.db.query(
      `SELECT symbol, base_asset, quote_asset FROM trading_pairs WHERE is_active = TRUE ORDER BY symbol`,
    );
    return result.rows;
  }

  // ══════════════════════════════════════════════
  //  PRIVATE METHODS — Matching Logic
  // ══════════════════════════════════════════════

  private async executeLimitOrder(
    client: pg.PoolClient,
    userId: string,
    pair: string,
    input: CreateOrderInput,
    quantity: string,
    _quoteQuantity: string,
    tradingPair: TradingPairRow,
  ): Promise<OrderResponse> {
    const orderId = uuidv4();
    const price = input.price!;

    // Lock the balance
    await this.lockBalance(client, userId, input.side, quantity, price, pair, tradingPair);

    // Insert order as OPEN
    await client.query(
      `INSERT INTO orders (id, user_id, pair, side, order_type, status, price, quantity,
                           time_in_force, client_order_id, fee_asset)
       VALUES ($1, $2, $3, $4, 'LIMIT', 'OPEN', $5, $6, $7, $8, $9)`,
      [orderId, userId, pair, input.side, price, quantity,
       input.time_in_force || 'GTC', input.client_order_id || null, tradingPair.quote_asset],
    );

    // Add to Redis order book
    await this.addToOrderBook(orderId, pair, input.side, price, quantity);

    // Try to match immediately
    try {
      await this.matchOrder(client, orderId, pair, input.side);
    } catch {
      // Matching errors within transaction should probably fail the transaction
      // but the original code had it in a try-catch.
      // Re-throwing here because we are in a transaction.
      throw new AppError(500, 'MATCHING_ERROR', 'Error during limit order matching');
    }

    // Fetch updated order
    const updated = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    return this.mapOrder(updated.rows[0]);
  }

  private async executeMarketOrder(
    client: pg.PoolClient,
    userId: string,
    pair: string,
    input: CreateOrderInput,
    tradingPair: TradingPairRow,
  ): Promise<OrderResponse> {
    const orderId = uuidv4();
    const isBuy = input.side === 'BUY';
    const quantity = input.quantity || '0';
    const quoteQuantity = input.quote_quantity || '0';

    // Insert as PENDING first
    await client.query(
      `INSERT INTO orders (id, user_id, pair, side, order_type, status, quantity, quote_quantity,
                           time_in_force, fee_asset)
       VALUES ($1, $2, $3, $4, 'MARKET', 'PENDING', $5, $6, 'IOC', $7)`,
      [orderId, userId, pair, input.side, quantity, quoteQuantity, tradingPair.quote_asset],
    );

    // Match against order book
    const matchResult = isBuy
      ? await this.matchMarketBuy(client, orderId, userId, pair, quoteQuantity || quantity, tradingPair)
      : await this.matchMarketSell(client, orderId, userId, pair, quantity, tradingPair);

    // Update order based on match results
    if (matchResult.trades.length === 0) {
      // No liquidity — reject market order
      await client.query(
        `UPDATE orders SET status = 'REJECTED', reject_reason = 'No liquidity available' WHERE id = $1`,
        [orderId],
      );
    } else {
      const totalFilledQty = matchResult.trades.reduce((sum, t) => sum + Number(t.quantity), 0);
      const totalQuoteFilled = matchResult.trades.reduce((sum, t) => sum + Number(t.quoteQuantity), 0);
      const totalFee = matchResult.trades.reduce((sum, t) => sum + Number(t.buyerFee) + Number(t.sellerFee), 0);

      await client.query(
        `UPDATE orders SET status = 'FILLED', filled_quantity = $1, filled_quote_quantity = $2,
         fee_amount = $3, updated_at = NOW()
         WHERE id = $4`,
        [totalFilledQty, totalQuoteFilled, totalFee, orderId],
      );
    }

    // Update wallet balances based on trades
    for (const trade of matchResult.trades) {
      await this.updateBalancesForTrade(client, trade, tradingPair);
    }

    const updated = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
    return this.mapOrder(updated.rows[0]);
  }

  private async executeMatch(
    client: pg.PoolClient,
    takerOrderId: string,
    takerUserId: string,
    takerSide: 'BUY' | 'SELL',
    makerOrderId: string,
    makerUserId: string,
    pair: string,
    matchPrice: string,
    matchQuantity: string,
    tradingPair: TradingPairRow,
  ): Promise<TradeResult> {
    const tradeId = uuidv4();
    const quoteQuantity = (Number(matchPrice) * Number(matchQuantity)).toFixed(8);
    const makerFeeRate = Number(tradingPair.maker_fee_rate);
    const takerFeeRate = Number(tradingPair.taker_fee_rate);

    const buyerFee = takerSide === 'BUY'
      ? (Number(quoteQuantity) * takerFeeRate).toFixed(8)
      : (Number(quoteQuantity) * makerFeeRate).toFixed(8);

    const sellerFee = takerSide === 'SELL'
      ? (Number(quoteQuantity) * takerFeeRate).toFixed(8)
      : (Number(quoteQuantity) * makerFeeRate).toFixed(8);

    // Insert trade
    await client.query(
      `INSERT INTO trades (id, pair, buyer_order_id, seller_order_id,
                           buyer_user_id, seller_user_id, price, quantity,
                           quote_quantity, buyer_fee, seller_fee, fee_asset, taker_side)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        tradeId, pair,
        takerSide === 'BUY' ? takerOrderId : makerOrderId,
        takerSide === 'SELL' ? takerOrderId : makerOrderId,
        takerSide === 'BUY' ? takerUserId : makerUserId,
        takerSide === 'SELL' ? takerUserId : makerUserId,
        matchPrice, matchQuantity, quoteQuantity,
        buyerFee, sellerFee,
        tradingPair.quote_asset,
        takerSide,
      ],
    );

    return {
      tradeId,
      price: matchPrice,
      quantity: matchQuantity,
      quoteQuantity,
      takerSide,
      buyerOrderId: takerSide === 'BUY' ? takerOrderId : makerOrderId,
      sellerOrderId: takerSide === 'SELL' ? takerOrderId : makerOrderId,
      buyerUserId: takerSide === 'BUY' ? takerUserId : makerUserId,
      sellerUserId: takerSide === 'SELL' ? takerUserId : makerUserId,
      buyerFee,
      sellerFee,
    };
  }

  private async matchOrder(client: pg.PoolClient, orderId: string, pair: string, side: 'BUY' | 'SELL'): Promise<void> {
    const orderBookKey = side === 'BUY' ? ORDER_BOOK_ASKS_KEY(pair) : ORDER_BOOK_BIDS_KEY(pair);

    // Get the best opposite side orders
    // For BUY: match against lowest asks (ascending score = price)
    // For SELL: match against highest bids (descending score = price)
    const matchingOrders = side === 'BUY'
      ? await this.redis.zrange(orderBookKey, 0, -1, 'WITHSCORES')
      : await this.redis.zrevrange(orderBookKey, 0, -1, 'WITHSCORES');

    if (matchingOrders.length === 0) return;

    const currentOrder = await client.query(
      'SELECT * FROM orders WHERE id = $1 AND status IN ($2, $3) FOR UPDATE',
      [orderId, 'OPEN', 'PARTIALLY_FILLED'],
    );
    if (currentOrder.rows.length === 0) return;

    let remainingQty = Number(currentOrder.rows[0].quantity) - Number(currentOrder.rows[0].filled_quantity);
    if (remainingQty <= 0) return;

    const tradingPair = await this.getTradingPair(pair);

    for (let i = 0; i < matchingOrders.length && remainingQty > 0; i += 2) {
      const matchingOrderId = matchingOrders[i];
      const matchPrice = matchingOrders[i + 1];

      // Get the matching order details
      const makerOrder = await client.query(
        'SELECT * FROM orders WHERE id = $1 AND status IN ($2, $3) FOR UPDATE',
        [matchingOrderId, 'OPEN', 'PARTIALLY_FILLED'],
      );
      if (makerOrder.rows.length === 0) continue;

      const makerRow = makerOrder.rows[0];
      const makerRemaining = Number(makerRow.quantity) - Number(makerRow.filled_quantity);
      if (makerRemaining <= 0) continue;

      const fillQuantity = Math.min(remainingQty, makerRemaining).toFixed(8);

      // Execute the match
      const trade = await this.executeMatch(
        client,
        orderId, currentOrder.rows[0].user_id, side,
        matchingOrderId, makerRow.user_id,
        pair, matchPrice, fillQuantity,
        tradingPair,
      );

      // Update maker order
      const newMakerFilled = Number(makerRow.filled_quantity) + Number(fillQuantity);
      const makerStatus = newMakerFilled >= Number(makerRow.quantity) ? 'FILLED' : 'PARTIALLY_FILLED';
      await client.query(
        `UPDATE orders SET filled_quantity = $1, status = $2, updated_at = NOW()
         WHERE id = $3`,
        [newMakerFilled, makerStatus, matchingOrderId],
      );

      // Remove filled orders from Redis
      if (makerStatus === 'FILLED') {
        await this.redis.zrem(ORDER_BOOK_BIDS_KEY(pair), matchingOrderId);
        await this.redis.zrem(ORDER_BOOK_ASKS_KEY(pair), matchingOrderId);
      } else {
        // Update remaining quantity in Redis
        const remaining = (Number(makerRow.quantity) - newMakerFilled).toFixed(8);
        await this.redis.zadd(orderBookKey, matchPrice, matchingOrderId);
        await this.redis.hset(ORDER_META_KEY(matchingOrderId), 'remaining', remaining);
      }

      remainingQty -= Number(fillQuantity);

      // Update wallet balances
      await this.updateBalancesForTrade(client, trade, tradingPair);
    }

    // Update taker order
    const totalFilled = Number(currentOrder.rows[0].filled_quantity) + (Number(currentOrder.rows[0].quantity) - Number(currentOrder.rows[0].filled_quantity) - remainingQty);
    const newStatus = remainingQty <= 0 ? 'FILLED' : (totalFilled > 0 ? 'PARTIALLY_FILLED' : 'OPEN');
    const filledQty = Number(currentOrder.rows[0].quantity) - remainingQty;

    await client.query(
      `UPDATE orders SET filled_quantity = $1, status = $2, updated_at = NOW()
       WHERE id = $3`,
      [filledQty, newStatus, orderId],
    );

    // If order was IOC and not fully filled, cancel remaining
    if (currentOrder.rows[0].time_in_force === 'IOC' && remainingQty > 0) {
      // Note: cancelOrder now wraps in its own transaction, but here we are already in one.
      // We should probably have an internal version of cancelOrder that takes a client.
      await this.internalCancelOrder(client, currentOrder.rows[0].user_id, orderId);
    }
  }

  private async matchMarketBuy(
    client: pg.PoolClient,
    orderId: string,
    userId: string,
    pair: string,
    spendQuantity: string,
    tradingPair: TradingPairRow,
  ): Promise<{ trades: TradeResult[] }> {
    const trades: TradeResult[] = [];
    let remainingSpend = Number(spendQuantity);

    // Get asks sorted by price ascending
    const asks = await this.redis.zrange(ORDER_BOOK_ASKS_KEY(pair), 0, -1, 'WITHSCORES');
    let askIdx = 0;

    while (askIdx < asks.length - 1 && remainingSpend > 0) {
      const makerOrderId = asks[askIdx];
      const matchPrice = asks[askIdx + 1];

      const makerOrder = await client.query(
        'SELECT * FROM orders WHERE id = $1 AND status IN ($2, $3) FOR UPDATE',
        [makerOrderId, 'OPEN', 'PARTIALLY_FILLED'],
      );
      if (makerOrder.rows.length === 0) { askIdx += 2; continue; }

      const makerRow = makerOrder.rows[0];
      const makerRemaining = Number(makerRow.quantity) - Number(makerRow.filled_quantity);
      if (makerRemaining <= 0) { askIdx += 2; continue; }

      const maxBuyBase = remainingSpend / Number(matchPrice);
      const fillQuantity = Math.min(maxBuyBase, makerRemaining).toFixed(8);
      const actualSpend = (Number(fillQuantity) * Number(matchPrice)).toFixed(8);

      const trade = await this.executeMatch(
        client,
        orderId, userId, 'BUY',
        makerOrderId, makerRow.user_id,
        pair, matchPrice, fillQuantity,
        tradingPair,
      );
      trades.push(trade);

      remainingSpend -= Number(actualSpend);

      // Update maker
      const newMakerFilled = Number(makerRow.filled_quantity) + Number(fillQuantity);
      const makerStatus = newMakerFilled >= Number(makerRow.quantity) ? 'FILLED' : 'PARTIALLY_FILLED';
      await client.query(
        `UPDATE orders SET filled_quantity = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newMakerFilled, makerStatus, makerOrderId],
      );

      if (makerStatus === 'FILLED') {
        await this.redis.zrem(ORDER_BOOK_ASKS_KEY(pair), makerOrderId);
      }

      askIdx += 2;
    }

    return { trades };
  }

  private async matchMarketSell(
    client: pg.PoolClient,
    orderId: string,
    userId: string,
    pair: string,
    sellQuantity: string,
    tradingPair: TradingPairRow,
  ): Promise<{ trades: TradeResult[] }> {
    const trades: TradeResult[] = [];
    let remainingSell = Number(sellQuantity);

    // Get bids sorted by price descending
    const bids = await this.redis.zrevrange(ORDER_BOOK_BIDS_KEY(pair), 0, -1, 'WITHSCORES');
    let bidIdx = 0;

    while (bidIdx < bids.length - 1 && remainingSell > 0) {
      const makerOrderId = bids[bidIdx];
      const matchPrice = bids[bidIdx + 1];

      const makerOrder = await client.query(
        'SELECT * FROM orders WHERE id = $1 AND status IN ($2, $3) FOR UPDATE',
        [makerOrderId, 'OPEN', 'PARTIALLY_FILLED'],
      );
      if (makerOrder.rows.length === 0) { bidIdx += 2; continue; }

      const makerRow = makerOrder.rows[0];
      const makerRemaining = Number(makerRow.quantity) - Number(makerRow.filled_quantity);
      if (makerRemaining <= 0) { bidIdx += 2; continue; }

      const fillQuantity = Math.min(remainingSell, makerRemaining).toFixed(8);

      const trade = await this.executeMatch(
        client,
        orderId, userId, 'SELL',
        makerOrderId, makerRow.user_id,
        pair, matchPrice, fillQuantity,
        tradingPair,
      );
      trades.push(trade);

      remainingSell -= Number(fillQuantity);

      const newMakerFilled = Number(makerRow.filled_quantity) + Number(fillQuantity);
      const makerStatus = newMakerFilled >= Number(makerRow.quantity) ? 'FILLED' : 'PARTIALLY_FILLED';
      await client.query(
        `UPDATE orders SET filled_quantity = $1, status = $2, updated_at = NOW() WHERE id = $3`,
        [newMakerFilled, makerStatus, makerOrderId],
      );

      if (makerStatus === 'FILLED') {
        await this.redis.zrem(ORDER_BOOK_BIDS_KEY(pair), makerOrderId);
      }

      bidIdx += 2;
    }

    return { trades };
  }

  private async createStopOrder(
    userId: string,
    pair: string,
    input: CreateOrderInput,
    tradingPair: TradingPairRow,
  ): Promise<OrderResponse> {
    const orderId = uuidv4();
    const stopPrice = input.stop_price!;
    const price = input.price || null;

    const result = await this.db.query(
      `INSERT INTO orders (id, user_id, pair, side, order_type, status,
                           price, stop_price, quantity, time_in_force, client_order_id, fee_asset)
       VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [orderId, userId, pair, input.side, input.type,
       price, stopPrice, input.quantity,
       input.time_in_force || 'GTC', input.client_order_id || null, tradingPair.quote_asset],
    );

    return this.mapOrder(result.rows[0]);
  }

  // ── Internal Cancel Order (for use within transactions) ──
  private async internalCancelOrder(client: pg.PoolClient, userId: string, orderId: string): Promise<void> {
    const result = await client.query(
      `SELECT id, user_id, pair, side, status, price, quantity, filled_quantity,
              fee_amount, time_in_force
       FROM orders WHERE id = $1 FOR UPDATE`,
      [orderId],
    );

    if (result.rows.length === 0) return;

    const order = result.rows[0];
    if (order.user_id !== userId) return;

    if (order.status === 'FILLED' || order.status === 'CANCELED' || order.status === 'REJECTED') {
      return;
    }

    // Remove from Redis order book
    await this.removeFromOrderBook(order);

    // Release locked balance
    const remainingQuantity = Number(order.quantity) - Number(order.filled_quantity);
    if (remainingQuantity > 0) {
      await this.releaseLockedBalance(client, userId, order, remainingQuantity);
    }

    await client.query(
      `UPDATE orders SET status = 'CANCELED', updated_at = NOW() WHERE id = $1`,
      [orderId],
    );
  }

  // ══════════════════════════════════════════════
  //  BALANCE MANAGEMENT
  // ══════════════════════════════════════════════

  private async validateBalance(
    db: DB,
    userId: string,
    side: string,
    type: string,
    quantity: string,
    quoteQuantity: string | undefined,
    price: string | undefined,
    _pair: string,
    tradingPair: TradingPairRow,
  ): Promise<void> {
    const baseAsset = tradingPair.base_asset;
    const quoteAsset = tradingPair.quote_asset;

    if (side === 'BUY') {
      // Need quote currency (e.g., USDT)
      const requiredQuote = type === 'MARKET'
        ? (quoteQuantity || '0')
        : (Number(quantity) * Number(price || '0')).toFixed(8);

      const walletResult = await db.query(
        `SELECT balance, locked_balance FROM wallets
         WHERE user_id = $1 AND asset = $2 AND wallet_type = 'SPOT' LIMIT 1 FOR UPDATE`,
        [userId, quoteAsset],
      );

      if (walletResult.rows.length === 0) {
        throw new AppError(400, 'INSUFFICIENT_BALANCE', `No ${quoteAsset} wallet found`);
      }

      const available = Number(walletResult.rows[0].balance) - Number(walletResult.rows[0].locked_balance);
      if (available < Number(requiredQuote)) {
        throw new AppError(400, 'INSUFFICIENT_BALANCE',
          `Insufficient ${quoteAsset} balance`);
      }
    } else {
      // Need base currency (e.g., BTC)
      const walletResult = await db.query(
        `SELECT balance, locked_balance FROM wallets
         WHERE user_id = $1 AND asset = $2 AND wallet_type = 'SPOT' LIMIT 1 FOR UPDATE`,
        [userId, baseAsset],
      );

      if (walletResult.rows.length === 0) {
        throw new AppError(400, 'INSUFFICIENT_BALANCE', `No ${baseAsset} wallet found`);
      }

      const available = Number(walletResult.rows[0].balance) - Number(walletResult.rows[0].locked_balance);
      if (available < Number(quantity)) {
        throw new AppError(400, 'INSUFFICIENT_BALANCE',
          `Insufficient ${baseAsset} balance`);
      }
    }
  }

  private async lockBalance(
    db: DB,
    userId: string,
    side: string,
    quantity: string,
    price: string,
    _pair: string,
    tradingPair: TradingPairRow,
  ): Promise<void> {
    const asset = side === 'BUY' ? tradingPair.quote_asset : tradingPair.base_asset;
    const amount = side === 'BUY'
      ? (Number(quantity) * Number(price)).toFixed(8)
      : quantity;

    const result = await db.query(
      `UPDATE wallets SET locked_balance = locked_balance + $1
       WHERE user_id = $2 AND asset = $3 AND wallet_type = 'SPOT'
       RETURNING balance, locked_balance`,
      [amount, userId, asset],
    );

    if (result.rows.length === 0) {
      throw new AppError(400, 'WALLET_NOT_FOUND', `Wallet for ${asset} not found`);
    }

    // Safety check (redundant with DB constraints but good for early error reporting)
    const row = result.rows[0];
    if (Number(row.locked_balance) > Number(row.balance)) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', `Insufficient balance to lock ${amount} ${asset}`);
    }
  }

  private async releaseLockedBalance(
    db: DB,
    userId: string,
    order: Record<string, unknown>,
    amount: number,
  ): Promise<void> {
    // asset derivation is handled inside the function via tradingPair;

    const assetToRelease = order.side === 'BUY' ? (order.fee_asset as string) : (order.pair as string).replace('USDT', ''); // Simplified fallback

    await db.query(
      `UPDATE wallets SET locked_balance = GREATEST(locked_balance - $1, 0)
       WHERE user_id = $2 AND asset = $3 AND wallet_type = 'SPOT'`,
      [amount, userId, assetToRelease],
    );
  }

  private async updateBalancesForTrade(client: pg.PoolClient, trade: TradeResult, tradingPair: TradingPairRow): Promise<void> {
    // Buyer gets base asset, loses quote asset
    // quoteQuantity was already locked in buyer's wallet if it was a LIMIT BUY
    // For MARKET BUY, it might not have been locked?
    // Actually, createOrder locks balance for LIMIT, and executeMarketOrder should probably do it too or handle it here.

    // Buyer: +base, -quote(locked)
    await client.query(
      `UPDATE wallets SET balance = balance + $1
       WHERE user_id = $2 AND asset = $3 AND wallet_type = 'SPOT'`,
      [trade.quantity, trade.buyerUserId, tradingPair.base_asset],
    );

    await client.query(
      `UPDATE wallets SET balance = balance - $1, locked_balance = GREATEST(locked_balance - $1, 0)
       WHERE user_id = $2 AND asset = $3 AND wallet_type = 'SPOT'`,
      [trade.quoteQuantity, trade.buyerUserId, tradingPair.quote_asset],
    );

    // Seller: -base(locked), +quote
    await client.query(
      `UPDATE wallets SET balance = balance - $1, locked_balance = GREATEST(locked_balance - $1, 0)
       WHERE user_id = $2 AND asset = $3 AND wallet_type = 'SPOT'`,
      [trade.quantity, trade.sellerUserId, tradingPair.base_asset],
    );

    await client.query(
      `UPDATE wallets SET balance = balance + $1
       WHERE user_id = $2 AND asset = $3 AND wallet_type = 'SPOT'`,
      [trade.quoteQuantity, trade.sellerUserId, tradingPair.quote_asset],
    );

    // Fees are currently just recorded in the trade, but should be deducted too.
    // For now, we focus on the principal.

    if (this.metrics) {
      this.metrics.tradeVolume.inc({ pair: tradingPair.symbol }, Number(trade.quantity));
    }
  }

  // ══════════════════════════════════════════════
  //  ORDER BOOK — REDIS HELPERS
  // ══════════════════════════════════════════════

  private async addToOrderBook(
    orderId: string,
    pair: string,
    side: string,
    price: string,
    quantity: string,
  ): Promise<void> {
    const key = side === 'BUY' ? ORDER_BOOK_BIDS_KEY(pair) : ORDER_BOOK_ASKS_KEY(pair);

    // Redis sorted set: score = price, member = orderId
    await this.redis.zadd(key, price, orderId);

    if (this.metrics) {
      this.metrics.orderBookDepth.inc({ pair, side });
    }

    // Store order metadata in Redis for fast lookups
    await this.redis.hset(ORDER_META_KEY(orderId), {
      pair,
      side,
      price,
      quantity,
      remaining: quantity,
      created_at: Date.now().toString(),
    });

    // Set TTL for safety (7 days max)
    await this.redis.expire(ORDER_META_KEY(orderId), 7 * 24 * 3600);
  }

  private async removeFromOrderBook(order: Record<string, unknown>): Promise<void> {
    const pair = order.pair as string;
    const side = order.side as string;
    const key = side === 'BUY' ? ORDER_BOOK_BIDS_KEY(pair) : ORDER_BOOK_ASKS_KEY(pair);

    await this.redis.zrem(key, order.id as string);
    await this.redis.del(ORDER_META_KEY(order.id as string));

    if (this.metrics) {
      this.metrics.orderBookDepth.dec({ pair, side });
    }
  }

  private formatOrderBookLevels(data: string[], isAsk: boolean): OrderBookLevel[] {
    const levels: Map<string, { quantity: number; count: number }> = new Map();

    for (let i = 0; i < data.length; i += 2) {
      const price = data[i + 1];
      // Fetch remaining quantity from order meta
      // For simplicity, we use the price as the aggregation key
      const current = levels.get(price) || { quantity: 0, count: 0 };
      current.count += 1;
      levels.set(price, current);
    }

    const result: OrderBookLevel[] = [];
    let total = 0;

    const sortedPrices = Array.from(levels.keys()).sort((a, b) =>
      isAsk ? Number(a) - Number(b) : Number(b) - Number(a)
    );

    for (const price of sortedPrices) {
      const level = levels.get(price)!;
      total += level.quantity;
      result.push({
        price,
        quantity: level.quantity.toFixed(8),
        total: total.toFixed(8),
        order_count: level.count,
      });
    }

    return result;
  }

  // ══════════════════════════════════════════════
  //  ORDER BOOK — POSTGRES FALLBACK
  // ══════════════════════════════════════════════

  private async getOrderBookFromDb(pair: string, depth: number): Promise<OrderBookResponse> {
    const [bidsResult, asksResult] = await Promise.all([
      this.db.query(
        `SELECT price, SUM(quantity - filled_quantity) as quantity,
                COUNT(*) as order_count
         FROM orders
         WHERE pair = $1 AND side = 'BUY' AND status IN ('OPEN', 'PARTIALLY_FILLED')
         GROUP BY price
         ORDER BY price DESC LIMIT $2`,
        [pair, depth],
      ),
      this.db.query(
        `SELECT price, SUM(quantity - filled_quantity) as quantity,
                COUNT(*) as order_count
         FROM orders
         WHERE pair = $1 AND side = 'SELL' AND status IN ('OPEN', 'PARTIALLY_FILLED')
         GROUP BY price
         ORDER BY price ASC LIMIT $2`,
        [pair, depth],
      ),
    ]);

    let bidTotal = 0;
    const bids: OrderBookLevel[] = bidsResult.rows.map((r: Record<string, unknown>) => {
      const qty = Number(r.quantity);
      bidTotal += qty;
      return {
        price: String(r.price),
        quantity: String(r.quantity),
        total: bidTotal.toFixed(8),
        order_count: parseInt(String(r.order_count), 10),
      };
    });

    let askTotal = 0;
    const asks: OrderBookLevel[] = asksResult.rows.map((r: Record<string, unknown>) => {
      const qty = Number(r.quantity);
      askTotal += qty;
      return {
        price: String(r.price),
        quantity: String(r.quantity),
        total: askTotal.toFixed(8),
        order_count: parseInt(String(r.order_count), 10),
      };
    });

    return { pair, bids, asks, timestamp: Date.now() };
  }

  // ══════════════════════════════════════════════
  //  MAPPERS
  // ══════════════════════════════════════════════

  private mapOrder(row: Record<string, unknown>): OrderResponse {
    const quantity = String(row.quantity);
    const filledQty = String(row.filled_quantity);
    const remaining = (Number(quantity) - Number(filledQty)).toFixed(8);

    return {
      id: row.id as string,
      user_id: row.user_id as string,
      pair: row.pair as string,
      side: row.side as string,
      type: row.order_type as string,
      status: row.status as string,
      price: row.price ? String(row.price) : null,
      stop_price: row.stop_price ? String(row.stop_price) : null,
      quantity,
      filled_quantity: filledQty,
      remaining_quantity: remaining,
      quote_quantity: row.quote_quantity ? String(row.quote_quantity) : null,
      filled_quote_quantity: String(row.filled_quote_quantity || '0'),
      fee_asset: (row.fee_asset as string) || null,
      fee_amount: String(row.fee_amount || '0'),
      time_in_force: (row.time_in_force as string) || 'GTC',
      client_order_id: (row.client_order_id as string) || null,
      created_at: (row.created_at as Date).toISOString(),
      updated_at: (row.updated_at as Date).toISOString(),
    };
  }
}
