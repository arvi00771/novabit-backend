/**
 * NovaBit Exchange — Wallet Service
 *
 * Handles wallet balance queries, deposit address management,
 * withdrawal requests, and transaction history.
 * All JWT auth is handled at the route layer.
 */

import pg from 'pg';
import { AppError } from '../middleware/error-handler.js';
import {
  CreateWithdrawalInput,
  TransactionResponse,
  WithdrawalResponse,
  WalletResponse,
} from '../schemas/wallet.js';

export class WalletService {
  constructor(private db: pg.Pool) {}

  // ── List all wallets for user ────────────────
  async listWallets(userId: string): Promise<WalletResponse[]> {
    const result = await this.db.query(
      `SELECT id, asset, wallet_type, balance, locked_balance,
              address, is_active
       FROM wallets
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY asset ASC`,
      [userId],
    );

    return result.rows.map(this.mapWalletResponse);
  }

  // ── Get specific wallet by asset ─────────────
  async getWallet(userId: string, asset: string): Promise<WalletResponse> {
    const result = await this.db.query(
      `SELECT id, asset, wallet_type, balance, locked_balance,
              address, is_active
       FROM wallets
       WHERE user_id = $1 AND asset = $2 AND wallet_type = 'SPOT'
       LIMIT 1`,
      [userId, asset.toUpperCase()],
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'WALLET_NOT_FOUND', `No wallet found for asset ${asset.toUpperCase()}`);
    }

    return this.mapWalletResponse(result.rows[0]);
  }

  // ── Get or generate deposit address ──────────
  async getDepositAddress(
    userId: string,
    asset: string,
    network: string,
  ): Promise<{ address: string; network: string; memo: string | null; asset: string }> {
    const assetUpper = asset.toUpperCase();
    const networkUpper = network.toUpperCase();

    // Ensure the user has a wallet for this asset
    const walletResult = await this.db.query(
      `SELECT id FROM wallets
       WHERE user_id = $1 AND asset = $2 AND wallet_type = 'SPOT'
       LIMIT 1`,
      [userId, assetUpper],
    );

    if (walletResult.rows.length === 0) {
      throw new AppError(404, 'WALLET_NOT_FOUND', `No wallet found. Deposit ${assetUpper} is not available.`);
    }

    const walletId = walletResult.rows[0].id;

    // Check for existing active deposit address
    const existingAddress = await this.db.query(
      `SELECT address, network, memo
       FROM deposit_addresses
       WHERE wallet_id = $1 AND user_id = $2 AND network = $3 AND is_active = TRUE
       LIMIT 1`,
      [walletId, userId, networkUpper],
    );

    if (existingAddress.rows.length > 0) {
      return {
        address: existingAddress.rows[0].address,
        network: existingAddress.rows[0].network,
        memo: existingAddress.rows[0].memo || null,
        asset: assetUpper,
      };
    }

    // Generate a mock deposit address (in production, call blockchain wallet API)
    // For now, generate a deterministic test address
    const mockAddress = this.generateMockAddress(assetUpper, userId);
    const memo = assetUpper === 'XRP' || assetUpper === 'EOS' ? this.generateMockMemo() : null;

    await this.db.query(
      `INSERT INTO deposit_addresses (wallet_id, user_id, asset, address, network, memo, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [walletId, userId, assetUpper, mockAddress, networkUpper, memo],
    );

    // Update wallet with deposit address
    await this.db.query(
      `UPDATE wallets SET address = $1 WHERE id = $2 AND address IS NULL`,
      [mockAddress, walletId],
    );

    return {
      address: mockAddress,
      network: networkUpper,
      memo,
      asset: assetUpper,
    };
  }

  // ── Submit withdrawal request ────────────────
  async createWithdrawal(
    userId: string,
    input: CreateWithdrawalInput,
    _ipAddress?: string,
  ): Promise<{ id: string; status: string; message: string }> {
    const asset = input.asset.toUpperCase();

    // Find the wallet
    const walletResult = await this.db.query(
      `SELECT id, balance, locked_balance, is_active
       FROM wallets
       WHERE user_id = $1 AND asset = $2 AND wallet_type = 'SPOT'
       LIMIT 1`,
      [userId, asset],
    );

    if (walletResult.rows.length === 0) {
      throw new AppError(404, 'WALLET_NOT_FOUND', `No wallet found for ${asset}`);
    }

    const wallet = walletResult.rows[0];

    if (!wallet.is_active) {
      throw new AppError(400, 'WALLET_DISABLED', 'This wallet is currently disabled');
    }

    const amount = input.amount;
    const availableBalance = Number(wallet.balance) - Number(wallet.locked_balance);

    if (Number(amount) <= 0) {
      throw new AppError(400, 'INVALID_AMOUNT', 'Withdrawal amount must be positive');
    }

    if (Number(amount) > availableBalance) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE',
        `Insufficient available balance. Available: ${availableBalance.toFixed(8)} ${asset}`);
    }

    // Calculate fee (simplified: 0.0005 BTC, 0.01 ETH, 1 USDT)
    const fee = this.calculateWithdrawalFee(asset);

    // Lock the balance
    await this.db.query(
      `UPDATE wallets
       SET locked_balance = locked_balance + $1
       WHERE id = $2`,
      [amount, wallet.id],
    );

    // Create withdrawal record
    const result = await this.db.query(
      `INSERT INTO withdrawals (user_id, wallet_id, asset, amount, fee, network,
                                to_address, memo, status, requires_2fa)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $9)
       RETURNING id, status`,
      [
        userId,
        wallet.id,
        asset,
        amount,
        fee,
        input.network,
        input.address,
        input.memo || null,
        !input.totp_code, // requires 2fa if no totp provided
      ],
    );

    const withdrawal = result.rows[0];

    // Create corresponding transaction record
    await this.db.query(
      `INSERT INTO transactions (user_id, wallet_id, type, status, asset, amount, fee,
                                 destination_address, reference_id, reference_type)
       VALUES ($1, $2, 'WITHDRAWAL', 'PENDING', $3, $4, $5, $6, $7, 'WITHDRAWAL_REQUEST')`,
      [userId, wallet.id, asset, amount, fee, input.address, withdrawal.id],
    );

    return {
      id: withdrawal.id,
      status: withdrawal.status,
      message: 'Withdrawal request submitted. It will be processed after review.',
    };
  }

  // ── List withdrawal history ─────────────────
  async listWithdrawals(
    userId: string,
    options: { status?: string; asset?: string; limit: number; offset: number },
  ): Promise<{ withdrawals: WithdrawalResponse[]; total: number }> {
    const conditions = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIndex = 2;

    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(options.status);
    }
    if (options.asset) {
      conditions.push(`asset = $${paramIndex++}`);
      params.push(options.asset.toUpperCase());
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM withdrawals WHERE ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(options.limit, options.offset);
    const result = await this.db.query(
      `SELECT id, asset, amount, fee, network, to_address, status, tx_hash,
              created_at, completed_at
       FROM withdrawals
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params,
    );

    return {
      withdrawals: result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        asset: row.asset as string,
        amount: String(row.amount),
        fee: String(row.fee),
        network: row.network as string,
        to_address: row.to_address as string,
        status: row.status as string,
        tx_hash: (row.tx_hash as string) || null,
        created_at: (row.created_at as Date).toISOString(),
        completed_at: row.completed_at ? (row.completed_at as Date).toISOString() : null,
      })),
      total,
    };
  }

  // ── List transaction history ────────────────
  async listTransactions(
    userId: string,
    options: { type?: string; status?: string; asset?: string; limit: number; offset: number },
  ): Promise<{ transactions: TransactionResponse[]; total: number }> {
    const conditions = ['user_id = $1'];
    const params: unknown[] = [userId];
    let paramIndex = 2;

    if (options.type) {
      conditions.push(`type = $${paramIndex++}`);
      params.push(options.type);
    }
    if (options.status) {
      conditions.push(`status = $${paramIndex++}`);
      params.push(options.status);
    }
    if (options.asset) {
      conditions.push(`asset = $${paramIndex++}`);
      params.push(options.asset.toUpperCase());
    }

    const whereClause = conditions.join(' AND ');

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM transactions WHERE ${whereClause}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(options.limit, options.offset);
    const result = await this.db.query(
      `SELECT id, type, status, asset, amount, fee, tx_hash,
              destination_address, source_address, reference_id, memo,
              created_at, confirmed_at
       FROM transactions
       WHERE ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
      params,
    );

    return {
      transactions: result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        type: row.type as string,
        status: row.status as string,
        asset: row.asset as string,
        amount: String(row.amount),
        fee: String(row.fee),
        tx_hash: (row.tx_hash as string) || null,
        destination_address: (row.destination_address as string) || null,
        source_address: (row.source_address as string) || null,
        reference_id: (row.reference_id as string) || null,
        memo: (row.memo as string) || null,
        created_at: (row.created_at as Date).toISOString(),
        confirmed_at: row.confirmed_at ? (row.confirmed_at as Date).toISOString() : null,
      })),
      total,
    };
  }

  // ── Private helpers ──────────────────────────

  private mapWalletResponse(row: Record<string, unknown>): WalletResponse {
    const balance = String(row.balance);
    const lockedBalance = String(row.locked_balance);
    const available = (Number(balance) - Number(lockedBalance)).toFixed(8);

    return {
      id: row.id as string,
      asset: row.asset as string,
      wallet_type: row.wallet_type as string,
      balance,
      locked_balance: lockedBalance,
      available_balance: available,
      address: (row.address as string) || null,
      is_active: row.is_active as boolean,
    };
  }

  private calculateWithdrawalFee(asset: string): string {
    const fees: Record<string, string> = {
      BTC: '0.0005',
      ETH: '0.01',
      USDT: '1',
      USDC: '1',
      SOL: '0.01',
      XRP: '0.25',
    };
    return fees[asset] || '0.001';
  }

  private generateMockAddress(asset: string, _userId: string): string {
    // In production, this would call a wallet management service/HD wallet
    const prefixes: Record<string, string> = {
      BTC: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      ETH: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
      USDT: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
      SOL: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuCQVz5iLxGXaw',
      XRP: 'rG1QQv2nh2gr7RCZ1P8YYcBUKCCN633jCn',
    };
    return prefixes[asset] || `mock_${asset}_${_userId.slice(0, 8)}`;
  }

  private generateMockMemo(): string {
    return Math.random().toString(36).substring(2, 12).toUpperCase();
  }
}