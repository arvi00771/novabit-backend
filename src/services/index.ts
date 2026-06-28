/**
 * NovaBit Exchange — Services Index
 *
 * Domain services are responsible for business logic.
 * They are injected into route handlers.
 *
 * Planned services:
 * - AuthService:    Registration, login, 2FA, password reset
 * - UserService:    Profile management, KYC workflow
 * - WalletService:  Balance queries, deposits, withdrawals
 * - OrderService:   Order creation, cancellation, history
 * - MatchingEngine: Limit/Market order matching (FIFO)
 * - MarketDataService: Order book, tickers, candlesticks
 * - AdminService:   User management, system config
 */

// Placeholder for future service implementations
export {};

// ── Planned service interface ─────────────────
// Each service will be a class or set of exported functions.
//
// Example:
// export class AuthService {
//   constructor(private db: Pool) {}
//
//   async register(input: RegisterUserInput): Promise<User> { ... }
//   async login(email: string, password: string): Promise<{ accessToken: string; refreshToken: string }> { ... }
//   async verify2FA(userId: string, totpCode: string): Promise<boolean> { ... }
// }