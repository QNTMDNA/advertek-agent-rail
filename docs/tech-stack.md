# Tech Stack — Advertek Agent Rail

Status: approved direction; migration in flight
Related: `docs/PRD.md`, `docs/okx-ai-integration.md`, `CLAUDE.md`

The system runs as a **pnpm monorepo** with a consolidated **Next.js app on
Vercel** (web, REST, remote MCP, webhooks), **Supabase Postgres** for
persistence, a **dedicated Node worker** for the treasury sweep, and a
**Python `deepagents` sidecar** as the demo buyer agent. Settlement stays on
Solana + QuickNode; fiat off-ramp stays on OKX.

## By layer

### Application & hosting — Next.js on Vercel
- Next.js (App Router) + React 19 + Tailwind v4 in `apps/web`, deployed on
  Vercel with Fluid compute and the Node.js runtime (Solana libs and `bigint`
  money require Node, not Edge).
- Absorbs the former `packages/site` landing page; an operator dashboard
  (orders, sweeps, reconciliation) reads from Supabase.
- Consumes `@advertek/*` packages via their built `dist/` output (workspace
  convention), with `transpilePackages` set so Next compiles them.
- **No private keys in Vercel env.** Building a USDC payment request (pay-to
  address + memo) requires no signing; only the treasury worker signs. The web
  app holds only Supabase credentials and webhook verification tokens.

### Agent interface — remote MCP via `mcp-handler`
- `mcp-handler` mounted at `app/api/mcp/route.ts`, serving Streamable HTTP
  statelessly, reusing the tool registrations from
  `packages/mcp-server/src/create-server.ts` (tool descriptions remain the
  single source of agent documentation).
- The local-dev stdio entry (`stdio-main.ts`, `.cursor/mcp.json`) is kept;
  remote is additive. stdio-only clients can bridge via `mcp-remote`.

### REST & webhooks — Next.js route handlers (Fastify retired)
- `POST /api/quotes` replaces the Fastify `POST /quotes` (same
  `@advertek/quote-api` core, Zod at the boundary).
- `POST /api/webhooks/quicknode` — QuickNode Streams confirmation
  (HMAC-SHA256 via `QUICKNODE_WEBHOOK_SECURITY_TOKEN`). **Webhook-first**:
  serverless functions cannot hold long-polling confirmation open.
- `POST /api/webhooks/advertek` — inbound Basic-auth-verified Advertek status
  events → `bridgeAdvertekStatusToOrderStatus` → fan-out.
- `POST /api/payments/moonpay/checkout` — fiat on-ramp: returns a signed
  MoonPay Buy URL (`@advertek/moonpay`) that charges the buyer in fiat and
  delivers the order's exact USDC to the settlement wallet, with the order id
  bound as `externalTransactionId` (same `advertek:order:{id}:{nonce}` shape
  as the Solana memo).
- `POST /api/webhooks/moonpay` — MoonPay Buy confirmation
  (`Moonpay-Signature-V2`, HMAC-SHA256 via `MOONPAY_WEBHOOK_KEY`, 5-minute
  replay window). Only `completed` transactions into our wallet/currency
  mark an order `paid`; idempotency key = MoonPay transaction id. The
  treasury sweep attributes these memo-less on-chain transfers via
  `OrderStore.findOrderIdByPaymentSignature`.
- Webhook handlers write to Postgres first (idempotency key = delivery id /
  tx signature), then trigger fulfillment — retries are safe.

### Persistence — Supabase Postgres (`packages/db`)
- Supabase Postgres is the system of record, accessed via `postgres`
  (postgres.js) with hand-written SQL migrations (`packages/db/migrations/`)
  behind an injected `SqlExecutor` seam — chosen over an ORM so unit tests
  use recording fakes and never touch a database (repo convention). Money
  columns are `numeric(78, 0)` crossed as base-10 strings, never float.
- Implements the former `STEP_9` seams: `OrderStatusUpdater`,
  `OrderDetailsLookup`, `WebhookSubscriptionLookup`, processed-deliveries
  table, and a Postgres `SweepLedger`.
- Supabase Realtime/Auth are optional add-ons for the operator dashboard.

### Treasury — dedicated Node worker (`apps/treasury-worker`)
- Thin always-on Node process wrapping `@advertek/treasury`'s sweep loop
  (`SWEEP_INTERVAL_MS`, thresholds, `reconcileSweeps`) against the Postgres
  `SweepLedger`. Deployed to Railway/Render/Fly — not Vercel.
- The **only** process holding money-moving secrets: the settlement-wallet
  keypair and `OKX_API_*` trading credentials. `OKX_WITHDRAWAL_API_*` never
  touches any automated environment.

### Demo buyer agent — Python `deepagents` sidecar (`agents/buyer-demo`)
- Python ≥ 3.11, `deepagents` (LangGraph-based harness) +
  `langchain-mcp-adapters` consuming the remote MCP server as tools; pays
  quotes from its own Solana wallet via `solders`; LangSmith for tracing.
- Deployed separately (LangGraph Platform or a small service); `uv` for deps,
  `ruff` + `pytest` for lint/test. Intentionally a consumer of the public
  rail — it dogfoods exactly what external agents experience.

### Settlement & off-ramp — unchanged
- Solana: `@solana/web3.js` + `@solana/spl-token`. QuickNode: RPC + Streams.
  OKX: REST v5 deposit/Convert for treasury. OKX AI marketplace remains an
  isolated Phase 0 experiment per `docs/okx-ai-integration.md`.

### Cross-cutting (unchanged conventions)
- pnpm 10.13.1 workspace, Node ≥ 22, TypeScript strict
  (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESLint
  `strictTypeChecked`, Vitest colocated unit tests, Zod at every trust
  boundary, per-package `config.ts` env parsing, all I/O dependency-injected,
  money as `bigint` minor units.

## Package map

| Path | Role |
|---|---|
| `apps/web` | Next.js app: landing page, `POST /api/quotes`, `/api/mcp`, webhook handlers |
| `apps/treasury-worker` | Always-on sweep worker (Railway/Render/Fly) |
| `agents/buyer-demo` | Python deepagents demo buyer (outside pnpm workspace) |
| `packages/db` | Drizzle + Postgres implementations of the persistence seams |
| `packages/mcp-server` | MCP tool registrations (core), stdio entry for local dev |
| `packages/quote-api` | Pricing core (HTTP layer lives in `apps/web`) |
| `packages/payments` | Solana USDC rail (unchanged) |
| `packages/moonpay` | MoonPay fiat↔USDC: signed Buy/Sell widget URLs, quotes, webhook verification, sell-transaction lookup |
| `packages/fulfillment` | Advertek production integration (unchanged) |
| `packages/treasury` | Sweep/reconcile core (unchanged; run by the worker) |
| `packages/types` / `catalog` / `webhooks` | Shared foundations (unchanged) |

## Architectural constraints

- **Serverless ≠ long-running.** Polling confirmation and the sweep loop
  never run in Vercel functions — confirmation is webhook-first (QuickNode
  Streams), sweeping runs in the dedicated worker.
- **Secret sprawl control.** Consolidating on Vercel must not pull signing
  keys into the web environment; the worker is the only key-bearing process.
- **`STEP_11` (fabricated pricing/rates) is orthogonal.** Real
  `AdvertekPricingClient` / `SpotRateClient` implementations are still
  required regardless of this topology.
