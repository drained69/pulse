/**
 * Temporary narration made with the macOS `say` voice, so the cut can be timed before the
 * Higgsfield recordings exist. Real recordings go in public/vo/<id>.mp3 (or .wav) and win
 * over these. Run: node scripts/vo-scratch.ts
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { FPS, VO } from "../src/timeline.ts";
import { probeDuration } from "./audio-io.ts";

const VOICE = process.env.SCRATCH_VOICE ?? "Samantha";
const RATE = process.env.SCRATCH_RATE ?? "182";
const out = path.resolve("public/vo-scratch");
fs.mkdirSync(out, { recursive: true });

if (process.platform !== "darwin") {
  console.log("vo-scratch: the scratch voice uses macOS `say`; skipping on this platform.");
  process.exit(0);
}

let over = 0;
for (const line of VO) {
  const file = path.join(out, `${line.id}.wav`);
  execFileSync("say", ["-v", VOICE, "-r", RATE, "--file-format=WAVE", "--data-format=LEI16@48000", "-o", file, line.say ?? line.text]);
  const dur = probeDuration(file);
  const slot = (line.end - line.start) / FPS;
  const flag = dur > slot ? "  ← too long" : "";
  if (dur > slot) over++;
  console.log(`${line.id.padEnd(22)} ${dur.toFixed(2)}s of ${slot.toFixed(2)}s${flag}`);
}
console.log(over ? `\n${over} line(s) overrun their slot.` : "\nEvery line fits its slot.");
