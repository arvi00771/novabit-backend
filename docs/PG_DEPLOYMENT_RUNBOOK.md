# NovaBit Exchange — PostgreSQL Production Deployment & Runbook

Goal: run the NovaBit Exchange backend against **real PostgreSQL** (not the
in-memory SQLite dev adapter), with **data integrity** and **secure KYC storage**.

Status: ✅ **Validated end-to-end** against PostgreSQL 16.15 — migrations 001–013
apply cleanly, `seed:test` provisions the demo admin, and the full test suite
passes **134/134 on PostgreSQL** (and 134/134 on the SQLite dev adapter).

---

## 1. Runtime DB selection (how DATABASE_URL works)

`src/config/index.ts` + `src/db/index.ts` decide the persistence layer:

- `DATABASE_URL` **set** → real PostgreSQL via `pg` (production path).
- `DATABASE_URL` empty/absent + `NODE_ENV` dev/test → in-memory SQLite adapter
  (`node:sqlite`) for local development and tests. **Never** run SQLite in prod.

The production gate (`config/index.ts`) **refuses to boot** when `NODE_ENV=production`
without explicit: `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `WALLET_SEED`, and
`KYC_DATA_DIR`. No ephemeral DB, no default secrets, no guessed KYC location.

## 2. Provisioning PostgreSQL

Requirements: PostgreSQL ≥ 15 (validated on 16). TLS and a dedicated role with
least privilege are recommended.

```sql
-- as postgres superuser (run once)
CREATE ROLE novabit WITH LOGIN PASSWORD '<strong-password>' CREATEDB;  -- CREATEDB only if the app user needs to create test DBs
CREATE DATABASE novabit OWNER novabit;
```

Connection string (set `DATABASE_URL` in the environment / secret store):

```
postgres://novabit:<strong-password>@<pg-host>:5432/novabit?sslmode=require
```

Do **not** hardcode credentials in the repo — `.env` is gitignored; use the
platform secret manager (GitHub Secrets, AWS SSM, K8s Secrets, etc.).

## 3. Migrations (schema)

Migrations live in `src/db/migrations/` (001–013), applied in numeric order by
`src/db/migrate.ts` with **checksum verification**. The runner refuses to apply
an already-applied version if the file changed (drift), and **fails loudly on
duplicate version numbers**.

```bash
# from repo root, with DATABASE_URL exported in the environment
npm run migrate:up       # apply all pending
npm run migrate:status   # show applied versions + checksum OK flags
npm run migrate:down     # revert the last migration (schema only)
npm run migrate:reset    # drop migrations table (recreate from scratch) — DANGEROUS
```

Version history relevant to production:

| Migration | Purpose |
|-----------|---------|
| 001–010 | Original schema (users, wallets, orders, trades, transactions, password_resets, supported_coins, staking, kyc_documents, audit_logs) |
| 011 | `users.recovery_codes` → TEXT (was TEXT[], which rejected the JSON-string the service writes) |
| 012 | Wallet balance CHECK constraints, idempotent (re-shipped from the version-6 collision; no env ever had them) |
| 013 | Seeds default trading pairs (BTCUSDT, ETHUSDT, SOLUSDT, ADAUSDT, AVAXUSDT) — mirrors the SQLite dev seed so `/market/pairs` isn't empty |

> Fresh installs apply 001→013 in order. Existing installs that already applied
> 001–010 receive 011→013 only. Do **not** edit applied migration files — add a
> new numbered migration instead (checksums are verified on every run).

### CI: migrate → seed → test on real PostgreSQL

`docker-compose.ci.yml` runs `npm run migrate:up && npm run seed:test && npm test`
against the `postgres:16-alpine` service. `npm run seed:test` is `src/db/seed-test.ts`,
which is **guarded to NODE_ENV=test only** — it creates the demo admin
`arvi00772@gmail.com / Test1234!` and never runs against a production database.

## 4. Testing before deploy

```bash
# SQLite dev path (no DATABASE_URL) — should pass 134/134
npm test

# PostgreSQL path (real DB) — should pass 134/134
export DATABASE_URL=postgres://novabit:...@localhost:5432/novabit
export NODE_ENV=test
npm run migrate:up && npm run seed:test && npm test
```

## 5. KYC document storage (sensitive PII)

- `KYC_DATA_DIR` must be an absolute, private, **persistent**, app-owned dir
  (recommend a dedicated volume, e.g. `/var/lib/novabit/kyc`).
- Startup preflight (`ensureKycDataDir`) enforces: absolute path, not under
  `/home/team/shared`, owned by the process user, `chmod 0700`, writable probe.
- **Production fails fast** if `KYC_DATA_DIR` is unset — no fallback guess.
- Dev/test default is `~/.local/share/novabit/kyc` (private under the app user's
  home — never the shared team volume, never ephemeral `/data`).

## 6. Deployment (Docker)

The `Dockerfile` `prod` target runs migrations automatically at container start:
`node dist/db/migrate.js up && node dist/app.js`.

```bash
# 1. Build
docker build --target prod -t novabit-backend:$(git rev-parse --short HEAD) .

# 2. Run with all required env from the secret store
docker run -d --name novabit-api \
  -p 3002:3000 \
  -e NODE_ENV=production \
  -e DATABASE_URL="$DATABASE_URL" \
  -e REDIS_URL="$REDIS_URL" \
  -e JWT_SECRET="$JWT_SECRET" \
  -e WALLET_SEED="$WALLET_SEED" \
  -e KYC_DATA_DIR=/var/lib/novabit/kyc \
  -e CORS_ORIGIN="$CORS_ORIGIN" \
  -v novabit_kyc:/var/lib/novabit/kyc \
  novabit-backend:$(git rev-parse --short HEAD)
```

## 7. Rollback / recovery

- **Code rollback**: keep the previous image tag; redeploy it. The app is
  backward-compatible with the schema (migrations are additive).
- **Schema rollback**: `npm run migrate:down` reverts the last migration
  (numeric). For 011–013 they are additive/seed-only — reverting is optional.
- **Data**: `pg_dump` (see §8). For a botched migration, restore the dump taken
  before deploy (see §8), then re-apply `npm run migrate:up`.
- **KYC docs**: restore the KYC volume from backup; keep it 0700 and app-owned.

## 8. Backups

```bash
# Full dump (schema + data) — run on a schedule
pg_dump "$DATABASE_URL" > novabit_$(date +%F_%H%M).sql

# KYC document volume
tar -czf novabit-kyc_$(date +%F).tar.gz -C /var/lib/novabit kyc

# Restore
createdb -O novabit novabit_restore && psql novabit_restore < novabit_2026-08-10.sql
```

Store backups off-host (object storage) with encryption. Test restore monthly.

## 9. Release gates for this change

- [x] Migrations 001–013 apply cleanly to a fresh PostgreSQL 16.15.
- [x] `seed:test` provisions the demo admin (users=1, wallets=3, pairs=5).
- [x] Full test suite 134/134 on PostgreSQL and 134/134 on SQLite dev.
- [x] `tsc --noEmit`: no new errors (2 pre-existing `ethers` declaration errors
      unchanged from main).
- [x] Production boot gate verified: missing DATABASE_URL/`KYC_DATA_DIR`/etc.
      under `NODE_ENV=production` → process exits with a clear message.
- [ ] **NOT deployed**: no live deployment until the production credentials are
      supplied (per task scope). The app is ready to consume `DATABASE_URL`.

## 10. Honest validation limitations

- CI's postgres job (`docker-compose.ci.yml`) was updated but the GitHub Actions
  run itself was not re-executed here (no docker daemon on this machine);
  the identical migrate/seed/test sequence was validated against a locally
  installed PostgreSQL 16.15, so CI behavior is expected to match.
- Docker image build (`prod` target) was not rebuilt on this machine (no docker
  daemon); the Dockerfile and compose changes are syntax-verified by review.