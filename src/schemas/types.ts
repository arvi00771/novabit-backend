/**
 * NovaBit Exchange — Shared Type Definitions & Zod Schemas
 *
 * These types define the core domain objects for the exchange.
 * They are shared across routes, services, and the WebSocket layer.
 */

import { z } from 'zod';

// ──────────────────────────────────────────────
// Enums
// ──────────────────────────────────────────────

export const OrderSide = z.enum(['BUY', 'SELL']);
export type OrderSide = z.infer<typeof OrderSide>;

export const OrderStatus = z.enum([
  'PENDING',
  'OPEN',
  'PARTIALLY_FILLED',
  'FILLED',
  'CANCELED',
  'REJECTED',
  'EXPIRED',
]);
export type OrderStatus = z.infer<typeof OrderStatus>;

export const OrderType = z.enum(['LIMIT', 'MARKET', 'STOP_LIMIT', 'STOP_MARKET']);
export type OrderType = z.infer<typeof OrderType>;

export const TransactionType = z.enum([
  'DEPOSIT',
  'WITHDRAWAL',
  'TRADE_BUY',
  'TRADE_SELL',
  'FEE',
  'TRANSFER',
  'REFUND',
]);
export type TransactionType = z.infer<typeof TransactionType>;

export const TransactionStatus = z.enum([
  'PENDING',
  'CONFIRMED',
  'FAILED',
  'CANCELED',
]);
export type TransactionStatus = z.infer<typeof TransactionStatus>;

export const UserRole = z.enum(['USER', 'VIP', 'ADMIN', 'SUPER_ADMIN']);
export type UserRole = z.infer<typeof UserRole>;

export const KycStatus = z.enum([
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
]);
export type KycStatus = z.infer<typeof KycStatus>;

export const WalletType = z.enum(['SPOT', 'TRADING', 'COLD', 'WITHDRAWAL']);
export type WalletType = z.infer<typeof WalletType>;

// ──────────────────────────────────────────────
// Domain Models (database row shapes)
// ──────────────────────────────────────────────

export interface User {
  id: string; // UUID
  email: string;
  password_hash: string;
  role: UserRole;
  kyc_status: KycStatus;
  kyc_verified_at: Date | null;
  is_2fa_enabled: boolean;
  is_withdrawal_whitelist_enabled: boolean;
  is_active: boolean;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Wallet {
  id: string; // UUID
  user_id: string; // FK -> users.id
  asset: string; // e.g. 'BTC', 'ETH', 'USDT'
  wallet_type: WalletType;
  balance: string; // DECIMAL stored as string to avoid precision loss
  locked_balance: string;
  address: string | null; // blockchain deposit address
  created_at: Date;
  updated_at: Date;
}

export interface Order {
  id: string; // UUID
  user_id: string; // FK -> users.id
  pair: string; // e.g. 'BTCUSDT'
  side: OrderSide;
  order_type: OrderType;
  status: OrderStatus;
  price: string | null; // null for MARKET orders
  stop_price: string | null; // null for non-stop orders
  quantity: string;
  filled_quantity: string;
  quote_quantity: string; // amount in quote currency
  filled_quote_quantity: string;
  fee_asset: string;
  fee_amount: string;
  client_order_id: string | null;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Trade {
  id: string; // UUID
  pair: string;
  buyer_order_id: string; // FK -> orders.id
  seller_order_id: string; // FK -> orders.id
  buyer_user_id: string;
  seller_user_id: string;
  price: string;
  quantity: string;
  quote_quantity: string;
  buyer_fee: string;
  seller_fee: string;
  fee_asset: string;
  taker_side: OrderSide;
  trade_time: Date;
}

export interface Transaction {
  id: string; // UUID
  user_id: string; // FK -> users.id
  wallet_id: string; // FK -> wallets.id
  type: TransactionType;
  status: TransactionStatus;
  asset: string;
  amount: string;
  fee: string;
  tx_hash: string | null; // blockchain transaction hash (for on-chain movements)
  destination_address: string | null;
  source_address: string | null;
  reference_id: string | null; // links to order_id or external reference
  memo: string | null;
  confirmed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

// ──────────────────────────────────────────────
// API Request/Response Schemas (Zod validated)
// ──────────────────────────────────────────────

// --- Auth ---
export const RegisterUserSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(8).max(128),
});
export type RegisterUserInput = z.infer<typeof RegisterUserSchema>;

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  totp_code: z.string().optional(),
});
export type LoginInput = z.infer<typeof LoginSchema>;

// --- Orders ---
export const CreateOrderSchema = z.object({
  pair: z.string().regex(/^[A-Z]{2,10}$/),
  side: OrderSide,
  order_type: OrderType,
  price: z.string().optional(),
  stop_price: z.string().optional(),
  quantity: z.string().min(1),
  client_order_id: z.string().max(64).optional(),
});
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

export const CancelOrderSchema = z.object({
  order_id: z.string().uuid(),
});

// --- Withdrawals ---
export const WithdrawSchema = z.object({
  asset: z.string().min(1).max(10),
  amount: z.string().min(1),
  address: z.string().min(1).max(255),
  memo: z.string().optional(),
  totp_code: z.string().optional(),
});

// --- API Response wrappers ---
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: number;
}