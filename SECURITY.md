# Security policy

## Reporting a vulnerability

Please report security problems privately through [GitHub's private vulnerability reporting](https://github.com/drained69/pulse/security/advisories/new) rather than in a public issue. Include what you found, how to reproduce it and what an attacker could do with it. You'll get an acknowledgement within 72 hours, and a fix or a plan within 14 days for anything serious. Please give us a reasonable time to fix an issue before disclosing it.

In scope: the hosted service at `qpulse-production.up.railway.app`, the code in this repository, and the two contracts on QIE mainnet (`QPulseBilling` `0x16D687505037a0A3E2B882F2bBa45E772807BEde`, `PulseAttestations` `0x4A6AcE957b37378D1F9BA917dE131E9f203A4967`).

Out of scope: denial of service by volume, findings that need a compromised user device or wallet, and issues in QIE's own RPC nodes, explorer or wallet (report those to the QIE team).

## How Q-Pulse protects users

- **No custody.** Payments go from the payer's wallet straight to the recipient. The contracts never hold funds. Q-Pulse never sees a private key: signing in is a signature over a single-use message, not a transaction.
- **Secrets stored as hashes.** API keys and session tokens are stored only as SHA-256 hashes. Discord webhook URLs are shown masked.
- **Signed webhooks.** Every delivery is signed with HMAC-SHA256 over the timestamp and the raw body, with a 5-minute replay window. Verify it (the SDK's `verifyWebhook` does) before acting on it.
- **Server-side request forgery.** Webhook URLs must be public HTTPS addresses. Private, loopback, link-local and cloud-metadata ranges are refused, checked again at connection time, and redirects are not followed.
- **Phishing through alerts.** Token symbols are reduced to a plain ticker, event text is shortened and defanged in Telegram and Discord, and only official QUSDC and WQIE count as payments. Lookalike addresses and zero-value transfers are flagged.
- **Indexer completeness.** Every batch is checked against the block headers' logs blooms, and a node that lags or answers incompletely is taken out of rotation, so a bad RPC answer cannot silently drop a payment.
- **Abuse limits.** Rate limits per IP, request size limits, plan quotas, and caps on filters, open payment links, products and traction pages.
- **Browser hardening.** `HttpOnly`, `SameSite=Lax` session cookie, cross-origin writes refused, a Content-Security-Policy and `X-Frame-Options: DENY`.

The contracts' trust model (what the owner and the attester can and cannot do) is in [contracts/README.md](contracts/README.md#trust-model).
