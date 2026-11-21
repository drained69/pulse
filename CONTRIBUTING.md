# Contributing

Thanks for helping improve Q-Pulse. Bug reports, fixes and new triggers are all welcome.

## Set up

Requirements: Node 22.18+ (TypeScript runs directly through Node's type stripping, no build step for the server), pnpm 9, and Foundry for the contracts.

```bash
pnpm install
cp .env.example .env
pnpm --filter @qpulse/web build
pnpm dev                 # server with --watch, and the Vite dev server on :5173
```

## Before you open a pull request

```bash
pnpm typecheck           # server, web and SDK
pnpm test                # server and SDK tests, then forge test
pnpm e2e                 # optional: full run against a local fork of QIE mainnet (needs anvil)
```

CI runs the same checks on every push and pull request.

## Where things live

| Path | What |
|---|---|
| `apps/server/src` | Indexer, matching, delivery, Telegram bot, scheduler, REST API, MCP server, WebSocket RPC, payment links, products, attestations |
| `apps/server/test` | Node test runner tests (`node --test`), one file per area |
| `apps/web/src` | Dashboard, checkout, product, device and public pages (React + Vite) |
| `packages/sdk` | `qpulse-sdk`, published to npm |
| `contracts` | Foundry project: contracts, tests, deploy scripts |
| `examples` | Small, dependency-free integrations |
| `docs` | Architecture, self-hosting, build log |

[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) explains how the parts fit together and why.

## Conventions

- **Never lose or duplicate an event.** Anything that touches the indexer or delivery needs a test that restarts mid-way and checks nothing is lost or delivered twice.
- **Validate at the edge.** Request bodies and trigger configs are parsed with zod; keep new inputs the same.
- **No secrets in code, logs or tests.** API keys and session tokens are stored hashed; don't log webhook URLs or tokens.
- **Plain language in the UI.** Short sentences, the exact name of the button, no jargon a shop owner wouldn't know.
- Commits: one focused change per commit, written in the imperative ("Add liquidity trigger").

## Adding a trigger

1. Add its config schema and matching in `apps/server/src/triggers.ts`, and its payload in `payload.ts`.
2. Add the type to the SDK (`packages/sdk/src/types.ts`) and the form in `apps/web/src/pages/HookForm.tsx`.
3. Add tests, a row in the Docs page's trigger table, and a template in `apps/web/src/templates.ts` if it suits non-developers.

By contributing you agree that your contribution is licensed under the [MIT licence](LICENSE).
