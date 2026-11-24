/** Where things sit in each format. Stage = the full output frame. */
export type Fmt = "landscape" | "portrait";
export type Rect = { x: number; y: number; w: number; h: number };
export type Pt = { x: number; y: number };

export const SIZE: Record<Fmt, { w: number; h: number }> = {
  landscape: { w: 1920, h: 1080 },
  portrait: { w: 1080, h: 1920 },
};

/** Width the web app is laid out at inside the browser frame (CSS px). */
export const VIEW_W: Record<Fmt, number> = { landscape: 1280, portrait: 1100 };
/** Height of the browser's title/URL bar in stage px. */
export const CHROME_H = 50;
/** Phone screen size in CSS px, and the bezel around it in stage px. */
export const PHONE_W = 390;
export const BEZEL = 13;

const R = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

export const BROWSER: Record<Fmt, { solo: Rect; duo: Rect }> = {
  landscape: { solo: R(690, 118, 1134, 846), duo: R(650, 176, 870, 650) },
  portrait: { solo: R(56, 610, 968, 1210), duo: R(56, 566, 968, 790) },
};

export const PHONE: Record<Fmt, { duo: Rect; off: Rect }> = {
  landscape: { duo: R(1440, 98, 404, 872), off: R(1980, 140, 404, 872) },
  portrait: { duo: R(586, 1012, 420, 880), off: R(1140, 1060, 420, 880) },
};

export const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  w: a.w + (b.w - a.w) * t,
  h: a.h + (b.h - a.h) * t,
});

export const browserScale = (fmt: Fmt, r: Rect): number => r.w / VIEW_W[fmt];
export const phoneScale = (r: Rect): number => (r.w - BEZEL * 2) / PHONE_W;

/** Stage point of a CSS point inside the browser page, given the page scroll. */
export function inBrowser(fmt: Fmt, r: Rect, vx: number, vy: number, scroll = 0): Pt {
  const s = browserScale(fmt, r);
  return { x: r.x + vx * s, y: r.y + CHROME_H + (vy - scroll) * s };
}

/** Stage point of a CSS point on the phone screen. */
export function inPhone(r: Rect, vx: number, vy: number): Pt {
  const s = phoneScale(r);
  return { x: r.x + BEZEL + vx * s, y: r.y + BEZEL + vy * s };
}

export const center = (r: Rect): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
