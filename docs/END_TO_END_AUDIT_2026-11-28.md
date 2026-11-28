# End-to-end audit — 28 November 2026

Reviewed the current main branch after the QIE Oracles integration, with emphasis on the path from an alert configuration through remote reads, persisted state, event delivery, public status and MCP. Existing payment, billing, authentication, indexing, delivery and traction regression suites were also run. This records tested behavior and confirmed defects, not a guarantee that every possible issue has been eliminated.

## Confirmed defects fixed

1. **Scheduled events could be duplicated after a state-write failure.** The event and delivery were committed before the armed state or daily marker. A failed state write left the event persisted, and a retry could create another event. Thresholds, name watches and daily digests now commit event/outbox, counters and state in a shared SQLite transaction using existing nested savepoints.
2. **Edited conditions inherited the old condition’s state.** Changing an already-fired oracle hook to another feed or level left it disarmed. Hook updates now atomically clear trigger state when the normalized trigger type, configuration or resolved target changes. A label, destination or pause/resume change preserves state.
3. **Remote reads could finish against obsolete hook configurations.** Pausing, editing or deleting a hook while its oracle read was pending could still emit the previous alert or fail on a deleted row. Before persisting scheduled results, the worker now checks that the hook is still active and its condition matches the snapshot used for the read.

Eight new regression tests in `apps/server/test/scheduled-audit.test.ts` cover rollback/retry, feed/threshold edits, metadata updates, pause/resume, in-flight pause/edit/deletion, and atomic name-watch/digest persistence. Three original reproductions failed before the patches and passed afterward.

## End-to-end validation

`pnpm e2e` runs against a local Anvil fork of QIE mainnet. All signing, simulated payments, subscriptions and contract deployment occur on the local fork; upstream mainnet access is read-only. The extended run passed:

- Real QUSDC and native QIE transfers settle the intended payment links and deliver signed events; payments below the minimum are ignored.
- QIE ID resolution, QIEDEX swaps and prices, wallet activity, approvals and failed calls produce the expected events.
- The local billing contract unlocks Pro from its on-chain subscription event.
- A QIE Oracle feed is read from the fork, produces a signed `price.threshold` webhook with source/feed/address/update metadata, and fires once while its condition remains true.
- All six fresh oracle rows agree between public status and the authenticated MCP reader.
- Traction counts the expected successful and failed calls and serves its badge.
- A deliberately unavailable RPC endpoint fails over correctly.
- Restart/replay processes nine blocks without adding duplicate events or deliveries: 20 events, 20 deliveries, two paid links.

## Release checks

- Server: **160 passed**, including the eight new scheduled-alert regressions.
- SDK: **9 passed**.
- Solidity: **20 passed**, including fuzz coverage, with `forge test --offline`.
- Total: **189 unit/integration tests passed**, plus the separate mainnet-fork end-to-end run.
- Workspace typechecks and the production web build passed.

No schema migration, new dependency, environment-variable change, volume configuration change or smart-contract redeployment is required by these fixes. Production verification uses read-only health, status, RPC and UI checks; no production sign-in, hook creation, outgoing notification or financial transaction is required.
