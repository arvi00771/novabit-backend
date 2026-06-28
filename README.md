# NovaBit Exchange — Backend

## Project Structure

```
backend/
├── src/
│   ├── config/          # Environment configuration
│   │   └── index.ts
│   ├── db/
│   │   ├── migrations/  # SQL migration files (applied in order)
│   │   │   ├── 001_create_users.sql
│   │   │   ├── 002_create_wallets.sql
│   │   │   ├── 003_create_orders.sql
│   │   │   ├── 004_create_trades.sql
│   │   │   └── 005_create_transactions.sql
│   │   ├── index.ts     # Database connection module
│   │   └── migrate.ts   # Migration runner script
│   ├── middleware/       # Express-like middleware
│   │   ├── error-handler.ts
│   │   └── auth-guard.ts
│   ├── plugins/         # Fastify plugins
│   │   └── auth.ts      # JWT authentication plugin
│   ├── routes/          # API route handlers
│   │   ├── index.ts     # Route aggregator
│   │   └── health.ts    # Health check endpoints
│   ├── schemas/         # TypeScript types & Zod validation schemas
│   │   └── types.ts
│   ├── services/        # Business logic layer
│   │   └── index.ts
│   └── app.ts          # Fastify server entry point
├── .env.example        # Environment variable template
├── .eslintrc.json      # ESLint configuration
├── .prettierrc         # Prettier configuration
├── docker-compose.yml  # Local development services
├── package.json        # Dependencies & scripts
├── tsconfig.json       # TypeScript configuration
└── README.md           # This file
```

## Quick Start

### Prerequisites

- Node.js >= 20
- Docker & Docker Compose (for PostgreSQL & Redis)
- npm or yarn

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Copy environment variables
cp .env.example .env

# 3. Start PostgreSQL & Redis
docker compose up -d

# 4. Run database migrations
npm run migrate:up

# 5. Start development server
npm run dev
```

The API will be available at `http://localhost:3000` and Swagger docs at `http://localhost:3000/docs`.

### Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Compile TypeScript to JavaScript |
| `npm run start` | Run compiled production build |
| `npm run lint` | Run ESLint |
| `npm run format` | Format code with Prettier |
| `npm run test` | Run tests (Vitest) |
| `npm run migrate:up` | Apply all pending migrations |
| `npm run migrate:down` | Revert last migration |
| `npm run migrate:reset` | Drop migrations table (reapply with `up`) |
| `npm run migrate:status` | Show migration status |

## CI/CD Pipeline

This project uses GitHub Actions for continuous integration and deployment.

### Continuous Integration (CI)
Triggered on pull requests to `main` and `develop`.
- **Linting**: Checks code style using ESLint.
- **Type Checking**: Ensures TypeScript types are valid.
- **Tests**: Runs unit and integration tests using `docker-compose.ci.yml`.

### Continuous Deployment (CD)
Triggered on push to `main`.
- **Build**: Builds a production-ready Docker image.
- **Push**: Pushes the image to GitHub Container Registry (GHCR).
- **Deploy**: (Placeholder) Deploys the image to staging and production environments.

## Database Schema

### Core Tables

| Table | Description |
|-------|-------------|
| `users` | User accounts, authentication, KYC, 2FA |
| `refresh_tokens` | JWT refresh token storage |
| `api_keys` | Programmatic API access keys |
| `withdrawal_addresses` | Whitelisted withdrawal addresses |
| `wallets` | User wallet balances (per asset per type) |
| `deposit_addresses` | Blockchain deposit addresses |
| `trading_pairs` | Available trading pairs and fee rates |
| `orders` | Active and historical orders |
| `trades` | Executed trade fills |
| `candles` | OHLCV candlestick data |
| `transactions` | Immutable financial audit trail |
| `deposits` | Deposit tracking |
| `withdrawals` | Withdrawal request tracking |
| `schema_migrations` | Migration version tracking |

### Key Indexes

- Composite indexes on `orders(pair, status)` for order book queries
- Composite indexes on `trades(pair, trade_time)` for trade history
- Unique constraints on `wallets(user_id, asset, wallet_type)` for one-wallet-per-asset
- Unique constraint on `deposits(tx_hash, network)` to prevent double-processing

## API Design

All endpoints are prefixed with `/api/v1/`. Responses follow a consistent format:

```json
{
  "success": true,
  "data": { ... },
  "error": null,
  "timestamp": 1710000000000
}
```

Error responses:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [...]
  },
  "timestamp": 1710000000000
}
```

## Security Features

- **JWT authentication** with short-lived access tokens (15min) + refresh tokens
- **API keys** for programmatic trading with granular permissions
- **2FA** support via TOTP (Google Authenticator compatible)
- **Withdrawal whitelist** — withdrawals only to pre-approved addresses
- **Rate limiting** per IP and per user
- **Helmet** security headers (CSP relaxed for TradingView)
- **Input validation** via Zod schemas on all endpoints
- **Role-based access control** (USER, VIP, ADMIN, SUPER_ADMIN)
- **SQL injection protection** via parameterized queries

## Planned Services (Next)

- [ ] Auth endpoints (register, login, refresh, 2FA enable/verify)
- [ ] User profile & KYC endpoints
- [ ] Wallet endpoints (balances, deposit addresses)
- [ ] Order endpoints (create, cancel, history)
- [ ] Market data endpoints (order book, tickers, candles)
- [ ] Matching engine (FIFO limit/market order matching)
- [ ] Admin endpoints (user management, system config)
- [ ] WebSocket streams (order book depth, trades, tickers)


node_modules/
dist/
.env
*.log