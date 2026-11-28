# QIE Oracle verification

Verified with read-only `decimals()`, `description()` and `latestRoundData()` calls to `https://rpc1mainnet.qie.digital` at **2026-11-28T05:16:17.396Z**. `eth_chainId` returned `0x7c6` (1990).

Feeds must have a positive finite answer, a complete round and an update no older than six hours. All seven supplied feeds were queried; only the six fresh feeds are enabled.

| Feed | Address | Decimals | Contract description | Price at verification | Age (minutes) | Result |
| --- | --- | --- | --- | --- | --- | --- |
| QIE/USDT | `0x3Bc617cF3A4Bb77003e4c556B87b13D556903D17` | 8 | QIE / USDT | 0.16364433 | 6.0 | Enabled |
| BTC/USDT | `0x9E596d809a20A272c788726f592c0d1629755440` | 8 | BTC / USDT | 60002.55013841 | 37.9 | Enabled |
| ETH/USDT | `0x4bb7012Fbc79fE4Ae9B664228977b442b385500d` | 8 | ETH / USDT | 1661.27414513 | 14.9 | Enabled |
| SOL/USDT | `0xe86999c8e6C8eeF71bebd35286bCa674E0AD7b21` | 8 | SOL / USDT | 71.38759517 | 6.9 | Enabled |
| XRP/USDT | `0x804582B1f8Fea73919e7c737115009f668f97528` | 8 | XRP / USDT | 0.9459602 | 6.0 | Enabled |
| BNB/USDT | `0x775A56117Fdb8b31877E75Ceeb68C96765b031e6` | 8 | BNB / USDT | 553.14068182 | 6.0 | Enabled |
| XAUt/USD | `0x9aD0199a67588ee293187d26bA1BE61cb07A214c` | 8 | Gold / USD | 3646.74592635 | 569.9 | Dropped: stale |

Prices above are a dated verification snapshot, not current quotes. For current prices and update timestamps, open the [public status page](https://qpulsev1.up.railway.app/#/status) or `/api/status`.

XAUt/USD returned `Gold / USD` and a positive answer, but its round was about 9.5 hours old. It was excluded rather than weakening the age limit. Supported USDT quotes are used directly, with no independent USDT/USD conversion.

`OracleService` batches all enabled `latestRoundData()` reads through the existing RPC pool, coalesces concurrent requests, and caches successful and failed reads for 60 seconds. It rechecks age on every read. A batch failure makes every feed unavailable for that cache window; malformed individual results affect only that feed. Alerts skip unavailable and stale data without changing their armed state. Metadata remains visible when a decoded round is stale. The public card and MCP tool expose the same reader output. No funds, signing or oracle contract writes are involved.

Changing a hook’s feed or threshold starts a new condition. Renaming a hook, changing its destination, or pausing and resuming it preserves the condition state. Scheduled events, delivery records, quota counters and trigger state commit together; a hook changed, paused or deleted during a remote read is skipped until the next check.
