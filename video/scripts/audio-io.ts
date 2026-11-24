/** Reading and writing audio with the ffmpeg that ships inside Remotion (no extra installs). */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ARCH_PKG: Record<string, string> = {
  "darwin-arm64": "compositor-darwin-arm64",
  "darwin-x64": "compositor-darwin-x64",
  "linux-x64": "compositor-linux-x64-gnu",
  "linux-arm64": "compositor-linux-arm64-gnu",
  "win32-x64": "compositor-win32-x64-msvc",
};

function binDir(): string {
  const pkg = ARCH_PKG[`${process.platform}-${process.arch}`];
  if (!pkg) throw new Error(`No Remotion compositor for ${process.platform}-${process.arch}`);
  const dir = path.resolve("node_modules/@remotion", pkg);
  if (!fs.existsSync(dir)) throw new Error(`Missing ${dir}. Run npm install.`);
  return dir;
}

function run(tool: "ffmpeg" | "ffprobe", args: string[]): Buffer {
  const dir = binDir();
  const exe = path.join(dir, process.platform === "win32" ? `${tool}.exe` : tool);
  return execFileSync(exe, args, {
    env: { ...process.env, DYLD_LIBRARY_PATH: dir, LD_LIBRARY_PATH: dir },
    maxBuffer: 1 << 30,
  });
}

export function probeDuration(file: string): number {
  return Number(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).toString().trim());
}

/** Decode any audio file to mono float32 at `rate`. */
export function decodeMono(file: string, rate: number): Float32Array {
  const buf = run("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "pipe:1"]);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)).slice();
}

/** Write interleaved stereo 16-bit PCM WAV. */
export function writeWav(file: string, left: Float32Array, right: Float32Array, rate: number): void {
  const n = left.length;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i]!)) * 32767), i * 4);
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i]!)) * 32767), i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([h, data]));
}
