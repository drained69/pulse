# Q-Pulse video audit

Revision: 22 November 2026. Reference UI: https://qpulsev1.up.railway.app/.

## Changes

| Finding | Revision |
|---|---|
| Runtime was 4:12.5 with setup starting at 0:53 | Runtime is 3:19.17; setup starts at 0:26. Saves 53.33 seconds (21.1%). |
| A separate audience introduction repeated the later examples | Removed that introduction; retained all audience workflows and the project-team traction example. |
| Voice fitting ranged from 0.815× to 1.556× between clips | Rebuilt from the original selected-voice recordings, shortened excess gaps, and used approximately 1.14–1.16× tempo while preserving pitch. |
| Captions advanced in equal-duration word groups | Matched the approved script to locally recognized word timestamps, with interpolation for unmatched names or acronyms; both formats use the same short phrase cues. |
| Many UI actions completed in the first few seconds | Name resolution, Telegram linking, payment alerts, checkout confirmation, and proof checks now follow their spoken cues. |
| Cursor remained over completed controls | Cursor now fades after the click, leaving the Paid confirmation and form results clear. |
| Final proof state appeared too briefly | Added reading time after verification and the final signature check. |
| The vertical cut shrank the desktop layout | Enlarged type, stacked the Telegram connection view, and gave the payment alert and webhook distinct focus states. Captions stay above the lower phone overlay area. |
| The illustrated UI and links used the previous presentation | Matched the current site's dark palette, pill navigation, headline, and public domain. Regenerated the example QR. |
| Old domain remained in code and documentation | Updated current references, including README, security scope, self-hosting and contract docs, SDK default and package metadata, launch/submission notes, video, and website canonical metadata. |

## Validation

- Reviewed 64 rendered stills: early and late states for 16 chapters in both formats.
- Checked that caption intervals are ordered, do not overlap, and remain inside their chapters; checked every action cue against chapter bounds.
- TypeScript checks pass for the video; the web production build and SDK build pass.
- All 9 existing SDK tests pass.
- New host: health, status, project listing, and Q-Pulse badge return HTTP 200. The existing Patungan documentation example is present.
- Both HTTP and WebSocket RPC return QIE mainnet chain ID 1990 at the new host.
- No old-domain references remain in current source or documentation; historical video backups and review captures are excluded.
- Final media verification checks H.264/yuv420p, AAC audio, expected frame count, exact dimensions, duration, full decoding, and measured audio loudness.

The local speech recognizer is used for timing; it is not the source of product claims or displayed caption wording. The approved script remains the text source.

Final exported audio measures -16.28 LUFS integrated with a -1.70 dB true peak after AAC encoding. Both dimensions contain 5,975 video frames at 30 fps, with 48 kHz stereo AAC and English subtitle tracks.
