# Build log

Everything in this repository was written from **18 November 2026** onwards. This page gives the development timeline, explains the shape of the git history, lists the on-chain milestones and says plainly how AI was used.

## Why the first commit is large

The first commit (`dc2152e`, 18 Nov 2026 20:22 UTC) adds about 14,000 lines in one go. The code was written that day in a local working copy and pushed to GitHub once it ran end to end, so the first day's work landed as one commit. Evidence that it is new work, not an older project re-dated:

- The project folder's first files were created on 18 Nov 2026 (about 04:30 UTC), the same day as the first commit. There is no earlier repository, fork or template behind it: no Scaffold-ETH, no starter kit, only libraries (viem, Hono, React, Vite, zod, ws, forge-std).
- The AI pair-programming sessions that produced it are timestamped from 18 Nov 2026 04:01 UTC.
- Every later feature arrived as its own focused commit (below), with the mainnet deployment, the security review fixes and the new features dated 19 and 21 November.

## Timeline

| Date (UTC) | Commit | Lines added | What changed |
|---|---|---|---|
| 18 Nov 20:22 | `dc2152e` | 13,941 | First working version: indexer over the 5 QIE RPC nodes, hooks (payment, transfer, swap, contract event, wallet, balance, price, name watch, digest), webhook / Telegram / Discord delivery with signing and retries, payment links, traction pages, dashboard, SDK, `QPulseBilling` contract, fork end-to-end test |
| 18 Nov 20:23 | `d2ba9cf` | 66 | Launch guide |
| 19 Nov 04:36 | `753cda7` | 111 | First rename |
| 19 Nov 06:40 | `9b26a11` | 1,375 | `eth_subscribe` WebSocket RPC for QIE, server-side filters, latency metrics |
| 19 Nov 06:58 | `cbad683` | 1,367 | On-chain traction attestations: `PulseAttestations`, Merkle proofs, browser and CLI verification |
| 19 Nov 07:04 | `9cc5861` | 7 | Docker build fix, `verify-traction` CLI |
| 19 Nov 07:29 | `399da91` | 451 | Rename to Q-Pulse; fixes from a first code review |
| 19 Nov 18:41 | `82112b5` | 907 | Dashboard and landing redesign |
| 19 Nov 18:56 | `a17c457` | 174 | Billing history import from the deploy block |
| 19 Nov 19:03 | `10ef37b` | 211 | UI polish |
| 21 Nov 08:18 | `6b439b7` | 820 | Full security review and fixes (indexer completeness via logs blooms, anti-phishing, payment-link reservations, rate caps); **mainnet deployment** of both contracts; account deletion, backups, terms and privacy |
| 21 Nov 08:29 | `2740f93` | 20 | Fix: QIE nodes answer `eth_fillTransaction` with only intrinsic gas, which made the first on-chain proof revert; traction badge |
| 21 Nov 09:37 | `7786a2b` | 300 | New theme and logo; landing page shows only live data |
| 21 Nov 12:38 | `429e231` | 33 | Dashboard polish after a page-by-page review |
| 21 Nov 13:04 | `f3f5aa8` | 1,694 | Products that unlock things (device view and receiver), pay-per-request APIs (HTTP 402), address-poisoning guard, rug-pull radar |
| 21 Nov 16:20 | `922ed47` | 453 | README rewrite |

## On-chain milestones

| When (UTC) | What | Transaction |
|---|---|---|
| 21 Nov 03:28 | `QPulseBilling` and `PulseAttestations` deployed, attester funded | [`0x0bc5…8d91`](https://mainnet.qie.digital/tx/0x0bc55f19766a953d7d64d7dbea6b1504f36310fe0924ddf56b53c8552e2c8d91) · [`0x884a…52f3`](https://mainnet.qie.digital/tx/0x884a18240f1204ed35696e00011d90af23a744a7240b923ce4ce12bdb6a752f3) |
| 21 Nov 08:16 | Attester key rotated to a fresh hot wallet | [`0x1ac1…25e2`](https://mainnet.qie.digital/tx/0x1ac141582ba7040e7a558ca2e22956f838528417e8695b02338c315cfebf25e2) |
| 21 Nov 08:22 | First daily traction proof reverted (out of gas, see `2740f93`) | [`0xa375…a3a1`](https://mainnet.qie.digital/tx/0xa375aa5a7bc1d65ed264d14020b3a1568cc9c34217b3269dec891d89f924a3a1) |
| 21 Nov 08:30 | First daily traction proof posted: 5 projects, independently verified with `verify-traction` | [`0x79df…c767`](https://mainnet.qie.digital/tx/0x79df0cab62e59a6350c34f67ef035624cbfcd22e5c8ef92ae256fc0973ebc767) |

A new proof is posted every day from then on.

## How AI was used

Q-Pulse was built with an AI pair programmer (Claude Code). The AI wrote most of the code from the team's direction; later commits carry a `Co-Authored-By` trailer that says so. The team decided what to build and how (the problem, the feature set, the trade-offs, the hosting), reviewed the changes, handled every wallet and key itself, signed the mainnet deployments, and tested the product with real wallets.

Because generated code needs checking, the project leans on evidence rather than claims: 137 automated tests (server, SDK and contracts, including fuzzing), an end-to-end test that runs the whole server against a fork of QIE mainnet with real transactions, a security review whose fixes each have a regression test, and on-chain proofs that anyone can recount from QIE's own explorer.
