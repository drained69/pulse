# Q-Pulse product walkthrough

A 3:19 narrated walkthrough using the current UI at **https://qpulsev1.up.railway.app/**, the Signal dark palette, Q-Pulse's logo, and bundled fonts. Explains the problem, demonstrates the merchant workflow, then shows practical examples for communities, traders, holders, sellers, project teams, developers, and AI agents.

## Outputs

- `out/qpulse-demo-audited-1920x1080.mp4`: audited widescreen master.
- `out/qpulse-demo-audited-1080x1920.mp4`: audited vertical master.
- `out/qpulse-demo-1920x1080.mp4` and `out/qpulse-demo-1080x1920.mp4`: canonical copies of the current masters.
- `out/qpulse-demo.srt`: speech-aligned English captions, also visible in both videos.
- `out/chapters.txt` and `out/script.txt`: chapter starts and narration.
- `review/audited/`: early and late visual checks for all 16 chapters in both formats.
- `AUDIT.md`: changes and validation evidence.

The earlier four-minute selected-voice videos and pre-audit sources are preserved in `backups/pre-audit/`. The original Grady recordings and cut are in `backups/grady/`.

## Rebuild

From this directory:

```sh
npm run check
npm run render
```

Requires Node, Python 3, ffmpeg/ffprobe, the installed Google Chrome, and the narration in `public/vo/`. The video remains outside the pnpm workspace.

`npm run prepare` validates the audited timing, creates the original instrumental bed, and exports captions and chapters. It refuses stale narration. `npm run render` renders the two formats concurrently, creates a continuous narration/music/effects mix, normalizes audio to -16 LUFS with a -1.8 dB true-peak target before AAC encoding, and verifies the exported streams and frame counts.

Narration uses Higgsfield Seed Audio 1.0 and the user's selected **neromtoobad** custom voice. The audit starts from the original files in `public/vo-neromtoobad/`, removes excess silent gaps, and applies a nearly uniform, pitch-preserving tempo adjustment. Scene lengths follow the resulting speech.

To revise the narration edit, run `python3 scripts/retime-audit.py` before `npm run render`. This optional editing step uses NumPy and the saved local speech audit in `src/generated/speech-audit.json`; ordinary renders do not download models or make generation requests. `src/scenes.json` holds the script, `src/generated/timing.json` holds timings and action cues, and `src/generated/captions.json` holds the shared caption phrases for both formats.

## Editorial accuracy

- Screens are designed demonstrations, with fictional wallets and activity labelled throughout. The README's current UI screenshot is captured from the public site.
- Telegram and webhook destinations use separate hooks.
- Signing in is a signature; making a payment is a separate transaction. Payment funds go to the recipient.
- Traction uses the product's actual verification wording.
- Warnings are signals for investigation and do not promise protection or trading returns.
- The webhook panel shows a shortened payload. Production receivers verify the timestamp and complete raw body.
- The seller QR opens the current app's payments page and is labelled as an example, rather than a payable checkout.
- `PLAN.md` is the original storyboard reference; the generated audited timing describes the current cut.
