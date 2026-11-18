#!/usr/bin/env bash
# End-to-end test against a local anvil fork of QIE mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v anvil >/dev/null || { echo "anvil not found: install Foundry (https://getfoundry.sh)"; exit 1; }
[ -d contracts/lib/forge-std ] || (cd contracts && forge install foundry-rs/forge-std --no-git)
(cd contracts && forge build -q)
cd apps/server && node test/e2e-fork.ts
