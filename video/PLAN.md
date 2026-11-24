# Q-Pulse demo video: plan

> Original 48-second concept. The delivered audited cut is 3:19; see [README](README.md) and [audit notes](AUDIT.md) for the current script, UI reference, timings, and exports.

48 seconds, 120 BPM (one bar = 2 s = 60 frames at 30 fps), every section starts on a bar.
Two exports from one composition: 1920×1080 and 1080×1920.

## What the repo changes in the brief

1. **The brand in the brief is the old one.** Commit `7786a2b` ("New 'Signal' theme and logo") replaced the
   olive / Newsreader / Figtree look. The three files the brief points to now say:
   - colours: ink `#14121c`, violet accent `#5b3fd6` (hover `#4a2fc2`, soft `#ece8fd`), lime `#c8f04b`,
     background `#f6f5fa`, brand gradient `#7c5cff → #3f22b8`
   - fonts: Space Grotesk (headlines), Inter (UI), JetBrains Mono (code and addresses)
   - logo: violet gradient rounded square, white ring, lime pulse line (`favicon.svg`)
   - still true: the floating pill header, the macOS window cards (`.window` with traffic lights), the line icons in `icons.tsx`

   The plan uses the current Signal brand, so the video matches the live product. Olive is still possible if
   you want it, but then the video would not match the site.
2. **The template is called "Shop payments".** Its description: "Message staff when someone pays your name.qie
   in QIE or QUSDC."
3. **One hook has one destination.** A Telegram alert and a webhook are two hooks. Step 4 opens on the Hooks list
   with both ("Shop payments" → Telegram, "Orchard server" → Webhook), so the two destinations are honest.
4. **There is no "Verified on-chain" string.** The real words are the badge `✓ Verified deployer`, the badge
   `✓ Anchored on QIE`, and the last step of "Verify in your browser":
   `✓ Verified: these numbers are on chain and match the explorer`. Step 6 uses those.
5. **Telegram linking** is "+ Connect a chat", then "Open @QPulseAlertsBot in Telegram", which sends
   `/start CODE`. The bot replies "✅ Linked **Sam** to Q-Pulse. Pick it as the destination when you create a hook."
   The dashboard's "Linked chats" table updates on its own.
6. **Live URL:** the README's live app is `https://qpulsev1.up.railway.app`. The close uses
   `Start free at qpulsev1.up.railway.app` unless you have a shorter domain.
7. **Wallet and Telegram screens are third-party apps.** They are drawn as neutral sheets and chat bubbles in
   Q-Pulse's own style, with no QIE Wallet or Telegram logos or exact trade dress. The bot avatar is Q-Pulse's
   own (`docs/brand/bot-avatar.svg`).

## Story and timing

| Time | Bars | Section | What happens |
|---|---|---|---|
| 0–4 s | 1–2 | Open | Frame 0 is the finished cover: logo, "Q-Pulse", "Real-time events for QIE", a phone with the alert peeking over the brand gradient. Slow push. At 3.5 s the logo flies into the pill header of the landing page (a match cut). |
| 4–10 s | 3–5 | 1 · Sign in | Landing hero in a browser. The cursor taps "Get started, free →". A signature sheet rises with the real sign-in message ("Sign in to Q-Pulse. This request does not send a transaction or cost any QIE."). Tap "Sign". The dashboard opens on "No hooks yet" with template tiles. |
| 10–18 s | 6–9 | 2 · Watch | Tap the "Shop payments" tile. New hook form, push in on "Recipient". Type `orchard.qie`. "Looking up orchard.qie on QIE ID…" then "✓ orchard.qie → 0x…". Pan down: QIE (native) and QUSDC ticked, "2. Where should we tell you?" Telegram selected, "No chats linked yet. Connect a Telegram chat first". Tap that link. |
| 18–24 s | 10–12 | 3 · Connect | Telegram page, tap "+ Connect a chat", push in on the code. Tap "Open @QPulseAlertsBot in Telegram". The phone slides in beside the browser. Tap START, `/start k3Xq9fP2aLmZ` sends, the bot replies "✅ Linked Sam…". The "Linked chats" row appears. Back on the form, "Create hook". The music starts to build. |
| 24–32 s | 13–16 | 4 · Alert (hero) | Side by side: Hooks list (two hooks, "Not fired yet") and the phone. Bar 13 builds; the block counter ticks and a payment pill flies in (`mira.qie → orchard.qie · 120 QUSDC`). **26.0 s drop:** the notification slides down the phone ("💸 orchard.qie received 120 QUSDC (~$120)", "From: mira.qie"), with the biggest push-in. It lands in the chat with "View on explorer". 28 s: the camera swings to a dark server window over the browser: `POST /qie-webhook 200`, the `QPulse-Signature: v1=…` header, the payload lines landing one by one, then "✓ signature verified". 30 s: pull back; both hook cards flip to "Last fired just now · 1 delivered". |
| 32–38 s | 17–19 | 5 · Get paid | Payment links page: type `35`, QUSDC, "Order #1043 · Fruit box", "Create link". "Link for 35 QUSDC ready." Tap "Open". The checkout shows "Pay orchard.qie", "Expires in 59:58", "35 QUSDC". Tap "Pay with QIE Wallet", then "Payment sent. Waiting for QIE to confirm it…". **36.0 s:** "✓ Paid" springs in with "Payment received. Confirmed on QIE just now…" and the chime. |
| 38–44 s | 20–22 | 6 · Prove | Public traction page "Orchard Market ✓ Verified deployer". The four stat cards count up and the 30-day bars grow. Pan to "On-chain proof ✓ Anchored on QIE", tap "Verify in your browser", the four checks tick on the beat, ending with "✓ Verified: these numbers are on chain and match the explorer". Push in. |
| 44–48 s | 23–24 | Close | Logo on the brand gradient. "Watch." "Alert." "Prove." land on three beats. Bar 24: a lime pill "Start free at qpulsev1.up.railway.app" with `github.com/drained69/pulse` under it. Hold, and the music resolves. |

### Captions

Each step has a caption beside the device: a number, a label, a headline and one line. The headlines and lines
reuse the site's own words (the "How it works" steps and the landing tour).

| # | Label | Headline | Supporting line |
|---|---|---|---|
| 01 | Sign in | Sign in with your wallet | Free, one signature, no transaction and no gas. |
| 02 | Watch | Pick what to watch | Start from a template: a payment to your name.qie. |
| 03 | Connect | Choose where it goes | Get a code, send it to @QPulseAlertsBot. |
| 04 | Alert | Know the moment money moves. | A Telegram message and a signed webhook, seconds after the block. |
| 05 | Get paid | Get paid without a memo field. | Send a link. It shows Paid within seconds. |
| 06 | Prove | Traction anyone can check. | Real wallets and transactions, committed on chain every day. |

Sizes at 1080p: headline 76 px Space Grotesk, line 34 px Inter, label 26 px. Portrait uses the same sizes at the top of the frame.

## Layout and camera

- **Landscape:** the caption column is on the left (about 520 px) and the browser on the right. In steps 3–4 the
  phone joins on the right and overlaps the browser's edge for depth.
- **Portrait:** the caption is at the top, the browser fills the middle, and in steps 3–4 the phone stacks under the
  browser, as the brief asks.
- **Camera:** one virtual camera per format, keyed to beats. It pushes in on the element that matters (the typed
  name, the code, the notification, the JSON, the Paid badge, the Verified line) and pulls back on the last beat of
  each step. Every cut lands on a bar. The biggest push-in is at 26.0 s.
- **Interaction:** an arrow cursor with a click ripple on the browser and a soft touch dot on the phone. Typing
  advances one character every 3 frames, with a blinking caret.
- **Fidelity:** the pages are rebuilt as static JSX with the real class names, and the real
  `apps/web/src/styles.css` is imported. Only the font variables and CSS animations are overridden, because
  animations must follow the frame.

## Sound

- **One timeline file** (`src/timeline.ts`) holds the bars, the section starts, the camera beats and every sound
  cue: taps, each keystroke, send, incoming message, notification, the webhook landing, the paid chime, count
  ticks, the verify checks and whooshes. The scenes read their timing from it.
- **`scripts/sound.ts`** (plain Node, no new tools) imports the same file and synthesises an original 120 BPM track
  plus every sound effect into one `soundtrack.wav`:
  - steps 1–3: soft kick, hats, pluck arpeggio and pad
  - bar 12 into bar 13: a riser and a snare build
  - 26.0 s: the drop, with a four-on-the-floor kick, bass, stabs and a sidechained pad
  - steps 5–6: the groove, lighter
  - close: a three-note motif on "Watch. Alert. Prove." and a resolving tonic chord with a tail
- **Drift guard:** the script writes a hash of the cue list. The composition refuses to render if the timeline
  changed and the soundtrack was not regenerated, so picture and sound cannot drift apart.

## Output and checks

- Renders: H.264, CRF 16, slow preset, PNG frames, yuv420p, BT.709, AAC 320 kbps:
  `out/qpulse-demo-1920x1080.mp4` and `out/qpulse-demo-1080x1920.mp4`, plus `out/cover-*.png` (frame 0).
- Before the export, I render stills of every scene in both formats (about 3 per scene) and check them for
  cropping, overlaps and text too small to read.
- Lives in `video/`, outside the pnpm workspace, so CI and `pnpm -r` are unaffected. Run `npm run render`.

## Example data (all made up)

| What | Example |
|---|---|
| Developer's shop | Orchard Market, `orchard.qie` → `0x3f9a…c21b` |
| Developer's wallet | `0x7a3c…91fe` |
| Customer | `mira.qie`; payment-link payer `0x91d2…4c07` |
| Telegram chat | private chat "Sam", link code `k3Xq9fP2aLmZ` |
| Hooks | "Shop payments" (Telegram), "Orchard server" (Webhook) |
| Payment | 120 QUSDC (~$120), block 12,486,241 |
| Webhook | event id, signature and tx hash: random hex |
| Payment link | 35 QUSDC, "Order #1043 · Fruit box", `inv_4be1c09a7f3d2e6b81a0` |
| Traction | Orchard Market: 1,284 wallets and 4,917 txs (7 days); 6,032 wallets and 21,480 txs (all time); snapshot 2026-11-20 of 9,812 txs from 2,604 wallets |
| Landing hero | block 12,486,213, 5 of 5 RPC nodes, 14 projects, "#1 Kite Escrow: 214 wallets this week", Lumen Pay on the leaderboard |

Nothing in the video comes from `.env`, Fly or Railway secrets, the database, real wallets or real users.
