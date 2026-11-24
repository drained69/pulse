import type { ReactNode } from "react";
import { easeInOut } from "./anim.ts";
import { SIZE, type Fmt } from "./layout.ts";

export type Cam = { x: number; y: number; z: number };
export type Move = { at: number; dur: number; to: Cam; ease?: (t: number) => number };

export const baseCam = (fmt: Fmt): Cam => ({ x: SIZE[fmt].w / 2, y: SIZE[fmt].h / 2, z: 1 });

/** Camera state at frame f: each move eases from wherever the camera was to `to`. */
export function camAt(f: number, start: Cam, moves: Move[]): Cam {
  let cur = start;
  for (const m of [...moves].sort((a, b) => a.at - b.at)) {
    if (f <= m.at) break;
    const t = m.dur <= 0 ? 1 : Math.min(1, (f - m.at) / m.dur);
    const e = (m.ease ?? easeInOut)(t);
    // Zoom is interpolated in log space so push-ins feel even.
    const z = Math.exp(Math.log(cur.z) + (Math.log(m.to.z) - Math.log(cur.z)) * e);
    cur = { x: cur.x + (m.to.x - cur.x) * e, y: cur.y + (m.to.y - cur.y) * e, z };
  }
  return cur;
}

/** Everything inside is filmed by the camera: (x, y) is the stage point at the centre of the frame. */
export function CameraStage({ fmt, cam, children }: { fmt: Fmt; cam: Cam; children: ReactNode }) {
  const { w, h } = SIZE[fmt];
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: w,
        height: h,
        transformOrigin: "0 0",
        transform: `translate(${w / 2 - cam.x * cam.z}px, ${h / 2 - cam.y * cam.z}px) scale(${cam.z})`,
      }}
    >
      {children}
    </div>
  );
}
