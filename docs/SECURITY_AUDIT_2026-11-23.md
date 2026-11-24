# QPulse security audit — 23 November 2026

Status: confirmed findings fixed, pushed to `main` and deployed to production on Railway on 24 November 2026; the `invoice_payments` migration runs when the server starts, and the deployed server is healthy. After the deploy, the live app rejects authentication writes from foreign origins (HTTP 403), and it serves the same dashboard build as this commit.

## Scope and method

Reviewed the server authentication, MCP and WebSocket interfaces, invoice settlement, delivery persistence, chain ingestion, project ownership checks, quotas, and webhook destination validation. Used local synthetic RPC responses, in-memory/file SQLite databases, and regression tests. Existing Solidity and SDK tests were also run. No live exploitation, production transactions, historical incident investigation, or production data changes were performed.

The repository contains existing UI, video, documentation, and domain migration work; that work was preserved. The Plamen orchestration reference files supplied in the audit instructions were unavailable on this computer, so this review used the accessible source and executable tests rather than claiming completion of that external workflow.

## Confirmed findings and fixes

Severity is a practical assessment of the reproduced condition, not a formal certification.

| Finding | Impact and condition | Fix | Regression evidence |
| --- | --- | --- | --- |
| High: payment replay after invoice amount reuse | Reprocessing a previously settled transfer could settle a new invoice with the reused amount inside the timestamp tolerance. | Durable settlement ledger keyed by native transaction or ERC-20 transaction/log index; atomic deduplication rechecked after asynchronous work. | `apps/server/test/audit-invoices.test.ts` |
| High: settlement and notification persistence were separate | An outbox failure could leave an invoice paid and a product sale counted without its notification; swallowed matching errors allowed cursor advancement. | Settlement, ledger, product counter, and hook outbox writes share one transaction; indexer propagates failures for retry. Optional name lookup occurs before the transaction. | `audit-invoices.test.ts`, `audit-chain.test.ts` |
| Medium: login origin and host-header trust | Public authentication writes lacked the browser-origin guard; cookie-authenticated writes could trust request-controlled host headers. | Check configured public/development origins on authentication writes and cookie-authenticated writes; remove host-header bypass. Clients without an Origin header remain supported. | `audit-auth.test.ts` |
| Medium: malformed MCP requests and coerced arguments | Invalid batch members could produce an HTTP failure alongside successful mutations; a string `"false"` could enable a hook. | Validate request envelopes and advertised argument types before executing tools; handle malformed and empty batches. | `audit-auth-mcp.test.ts` |
| Medium: concurrent quota bypasses | Overlapping requests could pass checks before asynchronous validation and exceed hook, product, checkout, or project limits. | Recheck quotas immediately before insertion in synchronous transactions; recheck filter capacity after asynchronous validation. | `audit-quotas.test.ts`, `audit-delivery.test.ts` |
| Medium: incomplete or mismatched RPC log responses | Nonempty partial responses escaped the earlier empty-log check; repeated failures eventually bypassed it. | Validate requested header numbers, log block numbers/hashes, duplicate/removed logs, mandatory blooms, and reconstructed bloom equality. Remove the repeated-failure bypass. Retry without advancing past detected inconsistencies. | `audit-chain.test.ts`, `stream.test.ts` |
| Medium: liquidity alert state committed before delivery persistence | Storage failure after updating alert state could suppress the alert on retry. | Delay state persistence until event/outbox writes succeed; existing event deduplication handles replay. | `audit-chain.test.ts` |
| Medium: borrowed infrastructure activity | Ownership of one unrelated contract could authorize adding protected shared infrastructure to a traction project. | Verify ownership independently for each protected infrastructure contract on creation or contract-list changes. | `audit-chain.test.ts` |
| Medium: unbounded growth of stored RPC filter ranges | A range ending at `latest` could exceed its allowed size after filter creation. | Revalidate the current range on `eth_getFilterLogs`. | `audit-delivery.test.ts` |
| Medium: malformed WebSocket upgrade target | URL parsing could throw out of the HTTP upgrade listener and terminate the process. | Return HTTP 400 and close malformed upgrades. | `audit-delivery.test.ts` |
| Low: deprecated private IPv6 destination | Deprecated site-local `fec0::/10` was not included in the webhook private-address blocklist. | Reject that range during destination validation. | `audit-delivery.test.ts` |

All test paths abbreviated above are under `apps/server/test/`.

## Validation

- Server: **134 passed, 0 failed**, including **25 audit regression tests**.
- SDK: **9 passed**.
- Solidity: **20 passed**, including two fuzz tests with 256 runs each, using `forge test --offline`.
- Total: **163 passing tests**.
- Workspace TypeScript checks: server, dashboard, and SDK passed.
- Server diff whitespace checks passed.

Existing invoice, project, and stream fixtures were corrected to supply matching block numbers, hashes, and log blooms. Production validation was not relaxed to accommodate inconsistent fixtures. The preexisting fork end-to-end workflow was not rerun as part of this audit.

## Migration and rollout

The next server startup automatically creates `invoice_payments` through the existing schema migration mechanism. Historical paid transactions are reserved with conservative transaction-wide legacy keys because old invoice rows do not contain log indices. Newly settled ERC-20 payments use individual log indices so distinct transfers within one transaction remain usable. Ledger entries survive invoice/account deletion through `ON DELETE SET NULL`; do not purge this ledger during routine cleanup.

Migration tests cover upgrading an existing database, preserving legacy settlement keys after deletion, outer transaction rollback, and nested savepoint rollback. Take the normal database backup before rollout and deploy the reviewed server changes to make these protections effective in production. No smart-contract redeployment is required by these patches.

## Limits and follow-up

Logs blooms are OR filters, not cryptographic completeness proofs. An RPC provider can omit logs with identical addresses/topics or colliding bloom bits without changing the bloom. Header/hash/bloom checks detect inconsistent responses but do not eliminate upstream trust. Missing or permanently inconsistent RPC data now stalls progress rather than being accepted; monitor cursor lag and provider health after deployment.

The origin policy depends on correct `PUBLIC_URL` and `DEV_ORIGINS` configuration. The infrastructure ownership change applies when projects are created or their contract lists change; it does not retroactively clean existing project rows. This review does not establish whether any issue was previously exploited or guarantee that no other vulnerabilities exist.
