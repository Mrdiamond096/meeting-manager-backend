# meeting-manager-backend

Express 5 + TypeScript REST API for Meeting Manager, with Prisma 7 on PostgreSQL 16. It runs on its own, or as
the `backend/` submodule of [meeting-manager](https://github.com/Mrdiamond096/meeting-manager), which adds the
web app and a reverse proxy. The API is documented in [docs/api-contract.md](docs/api-contract.md).

## Quick start (Docker)

Needs Docker with Compose v2.

```bash
make up                                        # api (dev image, hot reload) + postgres
curl http://localhost:3000/api/health/ready    # {"status":"ok"}
docker compose exec api npm run db:seed        # optional demo data, see below
```

`make up` runs migrations when the api container starts. `make down` stops the stack, `make clean` also deletes the
database volume, and `make help` lists every target.

Ports: API `:3000`, PostgreSQL `:5432` (user, password and database are all `meeting`).

## Local Node (without the api container)

Needs Node 24 (`.nvmrc`) and a PostgreSQL reachable at `DATABASE_URL`.

```bash
nvm use
npm install                   # also runs prisma generate
docker compose up -d db       # or use your own PostgreSQL
npm run db:deploy             # apply migrations
npm run dev                   # tsx watch on :3000
```

Without a `.env` loader the defaults in the table below apply. The default `DATABASE_URL` points at `localhost:5432`,
which is the compose database.

## Demo data and login

```bash
docker compose exec api npm run db:seed   # standalone backend
make seed                                 # from the umbrella repo, with its stack running
```

The seed creates one verified user plus 8 candidates with meetings and feedback, with dates relative to today so the
calendar always shows something this week. Running it again resets only what the demo user created; other accounts
are left alone.

| | |
|---|---|
| Email | `demo@example.com` (override: `SEED_DEMO_EMAIL`) |
| Password | `demo-password-123` (override: `SEED_DEMO_PASSWORD`) |
| OTP | `112233`: the mock provider accepts this fixed code (`OTP_MOCK_CODE`) |

When `NODE_ENV=production`, the seed refuses to run (exit 1) unless `ALLOW_DEMO_SEED=true`. The umbrella `make seed`
passes that flag for this one command only. Never set it on a server.

## Environment variables

Validated at startup in `src/config.ts`. An invalid value logs one JSON `fatal` line naming the variable (never its
value) and exits 1. Docker Compose reads `.env.example`.

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test` or `production`; the prod image sets `production` |
| `PORT` | `3000` | |
| `DATABASE_URL` | `postgres://meeting:meeting@localhost:5432/meeting` | **Production: required**, with a real password |
| `DB_STATEMENT_TIMEOUT_MS` | `5000` | Per-statement timeout |
| `LOG_LEVEL` | `info` (`silent` in test) | `fatal` … `trace`, `silent` |
| `LOG_PRETTY` | `false` | Human-readable logs for local dev; keep JSON in production |
| `APP_VERSION` | `dev` | Returned by `/api/health/live` |
| `RATE_LIMIT_ENABLED` | `true` | Turns every limit below on or off. Keep `true` in production |
| `RATE_LIMIT_LOGIN` | `5/15` | Each limit is `max/minutes`: max up to 999999, minutes up to 1440. Per IP + email |
| `RATE_LIMIT_REGISTER` | `3/60` | Per IP |
| `RATE_LIMIT_FORGOT_PASSWORD` | `3/60` | Per IP + email |
| `RATE_LIMIT_OTP_RESEND` | `10/15` | Per IP |
| `RATE_LIMIT_PASSWORD_RESET` | `10/15` | Per IP |
| `RATE_LIMIT_WRITE` | `60/1` | Creates, updates and deletes, per user |
| `COOKIE_SECURE` | `false` | **Production: `true`** (HTTPS only session cookie) |
| `ALLOWED_ORIGINS` | `http://localhost:8080,http://localhost:3001` | Comma-separated origins allowed to send state-changing requests. **Production: the real web origin** |
| `OTP_PROVIDER` | `mock` | Only `mock` exists. The API refuses to start with it when `NODE_ENV=production`… |
| `ALLOW_MOCK_OTP` | `false` | …unless this is `true`. Only for running the prod image locally (umbrella compose), never in a real deployment |
| `OTP_MOCK_CODE` | `112233` | Six digits accepted by the mock provider |
| `ALLOW_DEMO_SEED` | `false` | See the demo data section |
| `SEED_DEMO_EMAIL`, `SEED_DEMO_PASSWORD` | see above | Seed only; checked with the registration rules |

## Tests

Vitest + supertest against a real PostgreSQL. The global setup applies migrations to `DATABASE_URL` first.
**Each run truncates every table**, so tests use their own database, `meeting_test`, never the app's `meeting`.

```bash
make test-docker
```

This starts the compose PostgreSQL, creates `meeting_test` if it is missing, and runs the tests in a one-off api
container with `DATABASE_URL` pointing at it. `-e` overrides `.env.example`, and the container regenerates the Prisma
client that the `./src` bind mount hides.

Local Node, after `make test-docker` has created the database once (or
`docker compose exec db createdb -U meeting meeting_test`):

```bash
DATABASE_URL=postgres://meeting:meeting@localhost:5432/meeting_test npm test
```

`make test` without a `DATABASE_URL` falls back to the default, which is the app database, so always set it.

`npm run typecheck` checks types.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm audit --audit-level=high`, typecheck, migrations, tests, the
build, and then the production Docker image.

## Production image

```bash
docker build --target prod -t meeting-api .
```

The image runs as `node` with `NODE_ENV=production`, applies migrations (`prisma migrate deploy`), then starts
`dist/server.js`. The seed is never part of startup.

Health: `GET /api/health/live` (process up) and `GET /api/health/ready` (database reachable, otherwise 503).

## Layout

```
src/
  app.ts, server.ts, config.ts
  modules/{auth,meetings,candidates,feedback}/   router → service → repository (+ schemas, mapper)
  http/, observability/                          middleware, errors, logging, request ids
  db/                                            Prisma client, seed
prisma/                                          schema and migrations
test/                                            one folder per module, helpers/ for the shared app and DB
docs/api-contract.md                             the API contract (changes go in a separate "contract:" PR)
```
