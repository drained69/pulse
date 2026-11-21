# Q-Pulse contracts

Two small contracts on QIE mainnet (chain 1990), both source-verified on the QIE explorer. Neither holds funds.

| Contract | Address | Purpose |
|---|---|---|
| [`QPulseBilling`](src/QPulseBilling.sol) | [`0x16D687505037a0A3E2B882F2bBa45E772807BEde`](https://mainnet.qie.digital/address/0x16D687505037a0A3E2B882F2bBa45E772807BEde) | Pay for Q-Pulse Pro in QUSDC |
| [`PulseAttestations`](src/PulseAttestations.sol) | [`0x4A6AcE957b37378D1F9BA917dE131E9f203A4967`](https://mainnet.qie.digital/address/0x4A6AcE957b37378D1F9BA917dE131E9f203A4967) | Daily Merkle roots of every project's traction numbers |

Solidity 0.8.24, EVM `paris` (QIE does not support `PUSH0`), optimizer 200 runs, no external dependencies besides `forge-std` for tests and scripts.

## QPulseBilling

A subscription is a payment: the payer approves QUSDC, calls `subscribe`, and the QUSDC goes straight to the treasury in the same transaction. The server's indexer sees the `Subscribed` event and unlocks Pro until `paidUntil`.

| Function | Who | What it does |
|---|---|---|
| [`subscribe(planId, periods, maxAmount)`](src/QPulseBilling.sol#L63) | anyone | Pays `price × periods` from the caller to the treasury and extends the caller's `paidUntil`. Reverts with `PriceAboveMax` if the price is above `maxAmount`, so a price change can never overcharge a pending payment |
| [`subscribeFor(account, …)`](src/QPulseBilling.sol#L68) | anyone | Same, paid by the caller for another account (gifts, team plans) |
| [`quote(planId, periods)`](src/QPulseBilling.sol#L74) | view | The price of `periods` periods |
| [`isActive(account)`](src/QPulseBilling.sol#L93) | view | Whether `paidUntil[account]` is in the future |
| [`setPlan`](src/QPulseBilling.sol#L99), [`setTreasury`](src/QPulseBilling.sol#L109) | owner | Change a plan's price, period or availability; change where payments go |
| `transferOwnership`, `acceptOwnership` | owner, then new owner | Two-step handover, so ownership can't be sent to a mistyped address |

Rules: 1 to 24 periods per payment (`MAX_PERIODS`); renewals stack on top of time already paid; there is no automatic renewal and no way to pull funds from anyone. Plan 1 is Pro at 9 QUSDC per 30 days.

## PulseAttestations

Once a day the Q-Pulse server computes every public project's numbers for the last 30 days, builds a Merkle tree with one leaf per project and posts its root here. Anyone can then check a project's numbers against the chain without trusting the server.

| Function | Who | What it does |
|---|---|---|
| [`attest(epoch, root, leaves, snapshotBlock)`](src/PulseAttestations.sol#L61) | attester | Stores the root for day `epoch` (days since 1970). Append-only: each epoch must be after the latest one, not in the future, with a snapshot block in the past |
| [`verify(epoch, leaf, proof)`](src/PulseAttestations.sol#L74) | view | Whether `leaf` is in that day's tree |
| [`verifyStats(epoch, …, proof)`](src/PulseAttestations.sol#L81) | view | Hashes a project's numbers into a leaf and checks it, so a verifier passes plain numbers rather than a hash |
| [`leafHash(…)`](src/PulseAttestations.sol#L106) | pure | The leaf exactly as the server and the `verify-traction` CLI compute it |
| [`setAttester`](src/PulseAttestations.sol#L131) | owner | Rotate the attester key |

A leaf commits to the project's slug, its contracts, the window (`fromTs` to `toBlock`), the successful transaction count, the distinct wallet count and `txSetHash`, a hash of the exact set of transactions counted. Leaves are double-hashed (OpenZeppelin convention) to rule out second-preimage proofs, and pairs are hashed in sorted order. Because the leaf includes the transaction set, one dropped or invented transaction makes the proof fail.

To verify a project yourself: the **Verify in your browser** button on its traction page, or `pnpm verify-traction <slug> --api https://qpulse-production.up.railway.app` from the repository root. Both recount from QIE's explorer and read the root from a QIE node.

## Trust model

- The **owner** can change prices, the treasury and the attester. It cannot move anyone's funds (the contracts never hold any), charge a payer more than their `maxAmount`, or change or delete a past root.
- The **attester** is a hot wallet on the server that only holds gas. It can post one root per day. It cannot rewrite or backdate a day, and a wrong number is caught by anyone who recounts.
- What is trusted: that the attester posts every day, and the owner's choice of attester. The numbers themselves are checkable.

## Build, test, deploy

```bash
forge install foundry-rs/forge-std@v1.17.0 --no-git   # first time only (lib/ is not committed)
forge build
forge test        # 20 tests, including fuzz tests
```

Deploy both contracts and fund the attester in one transaction batch:

```bash
TREASURY=0x… ATTESTER=0x… forge script script/DeployAll.s.sol --rpc-url qie --broadcast --account deployer
```

| Script | Purpose |
|---|---|
| [`DeployAll.s.sol`](script/DeployAll.s.sol) | Both contracts plus attester funding (used for mainnet, block 12057730) |
| [`RotateAttester.s.sol`](script/RotateAttester.s.sol) | Set a new attester and fund it |
| [`Deploy.s.sol`](script/Deploy.s.sol), [`DeployAttestations.s.sol`](script/DeployAttestations.s.sol) | One contract at a time |

Full steps, including source verification on the QIE explorer, are in [docs/SELF_HOSTING.md](../docs/SELF_HOSTING.md).
