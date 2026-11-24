/**
 * The single source of timing for picture AND sound.
 *
 * Scenes read their key moments from `T`, and scripts/sound.ts reads `CUES` and `VO`
 * (both derived from `T`) to place every sound effect and voice line. Change a moment
 * here and both follow. The render refuses to start if the soundtrack was built from an
 * older version of this file (see `timelineHash` and src/generated/audio.json).
 *
 * Plain TypeScript with no imports, so Node can run it directly (type stripping).
 */

export const FPS = 30;
export const BPM = 120;
export const BEAT = (FPS * 60) / BPM; // 15 frames
export const BAR = BEAT * 4; // 60 frames = 2 s

export type SectionId =
  | "cover"
  | "problem"
  | "solution"
  | "audience"
  | "signin"
  | "template"
  | "telegram"
  | "alert"
  | "paylink"
  | "traction"
  | "uses"
  | "close";

/** Sections in order. `bar` is 1-based; every section starts on a bar. */
export const SECTIONS: { id: SectionId; bar: number; bars: number }[] = [
  { id: "cover", bar: 1, bars: 2 },
  { id: "problem", bar: 3, bars: 5 },
  { id: "solution", bar: 8, bars: 3 },
  { id: "audience", bar: 11, bars: 4 },
  { id: "signin", bar: 15, bars: 3 },
  { id: "template", bar: 18, bars: 4 },
  { id: "telegram", bar: 22, bars: 3 },
  { id: "alert", bar: 25, bars: 4 },
  { id: "paylink", bar: 29, bars: 3 },
  { id: "traction", bar: 32, bars: 3 },
  { id: "uses", bar: 35, bars: 6 },
  { id: "close", bar: 41, bars: 4 },
];

export const TOTAL_BARS = SECTIONS.reduce((n, s) => Math.max(n, s.bar + s.bars - 1), 0);
export const DURATION = TOTAL_BARS * BAR; // 2640 frames = 88 s

export const S = Object.fromEntries(SECTIONS.map((s) => [s.id, { from: (s.bar - 1) * BAR, dur: s.bars * BAR, bar: s.bar, bars: s.bars }])) as Record<
  SectionId,
  { from: number; dur: number; bar: number; bars: number }
>;

/** Absolute frame of `beat` (0-based, may be fractional) in bar `b` (0-based) of a section. */
export const at = (id: SectionId, b = 0, beat = 0): number => Math.round(S[id].from + b * BAR + beat * BEAT);

/** Frames at which each character of `text` appears when typed from `start`. */
export function typing(text: string, start: number, every = 3): number[] {
  return Array.from(text, (_, i) => start + i * every);
}

// ───────── key moments, per section ─────────

const typeName = "orchard.qie";
const typeAmount = "35";
const typeOrder = "Order #1043";
const typePayTo = "orchard.qie";

export const T = {
  cover: {
    block: at("cover", 1, 0),
    exit: at("cover", 1, 2.5),
  },
  problem: {
    card1: at("problem", 0, 1),
    error1: at("problem", 0, 3),
    card2: at("problem", 1, 2),
    error2: at("problem", 2, 0),
    card3: at("problem", 2, 2),
    pollTicks: [3, 4, 5, 6, 7, 8, 9, 10].map((i) => at("problem", 2, 2 + i * 0.5)),
    punch: at("problem", 4, 0),
    exit: at("problem", 4, 3),
  },
  solution: {
    blocks: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => at("solution", 0, 1 + i)),
    pillars: [at("solution", 1, 2), at("solution", 1, 3), at("solution", 2, 0)],
    exit: at("solution", 2, 3),
  },
  audience: {
    cards: [0, 1, 2, 3, 4, 5, 6, 7].map((i) => at("audience", 0, 1 + i * 0.5)),
    focus: at("audience", 2, 0),
    exit: at("audience", 3, 2),
  },
  signin: {
    cursorIn: at("signin", 0, 0.5),
    tapStart: at("signin", 0, 3),
    sheet: at("signin", 1, 0),
    tapSign: at("signin", 1, 3),
    dashboard: at("signin", 2, 0),
  },
  template: {
    tapTile: at("template", 0, 2),
    form: at("template", 0, 3),
    typeStart: at("template", 1, 2),
    typeName,
    lookup: at("template", 2, 0) - 6,
    resolved: at("template", 2, 1),
    scroll: at("template", 2, 2),
    tapConnect: at("template", 3, 1),
  },
  telegram: {
    tapConnect: at("telegram", 0, 1),
    card: at("telegram", 0, 1.5),
    tapOpen: at("telegram", 0, 3),
    phoneIn: at("telegram", 0, 3.3),
    tapStart: at("telegram", 1, 2),
    reply: at("telegram", 2, 0),
    linkedRow: at("telegram", 2, 1),
  },
  alert: {
    payment: at("alert", 0, 2),
    drop: at("alert", 1, 0),
    bubble: at("alert", 1, 2),
    webhook: at("alert", 2, 0),
    verified: at("alert", 2, 3),
    delivered: [at("alert", 3, 0) + 3, at("alert", 3, 0) + 9],
    latency: at("alert", 3, 1.5),
  },
  paylink: {
    typeAmount,
    typeOrder,
    typePayTo,
    amountStart: at("paylink", 0, 1),
    orderStart: at("paylink", 0, 1) + 8,
    payToStart: at("paylink", 0, 1) + 8 + typeOrder.length * 2 + 4,
    tapCreate: at("paylink", 1, 1),
    tapOpen: at("paylink", 1, 3),
    checkout: at("paylink", 1, 3) + 5,
    tapPay: at("paylink", 2, 0),
    paid: at("paylink", 2, 2),
  },
  traction: {
    countStart: at("traction", 0, 0.5),
    countEnd: at("traction", 0, 4),
    scroll: at("traction", 1, 0),
    tapVerify: at("traction", 1, 1),
    checks: [at("traction", 1, 2), at("traction", 1, 3), at("traction", 2, 0), at("traction", 2, 1)],
  },
  uses: {
    starts: [0, 1, 2, 3, 4, 5].map((i) => at("uses", i, 0)),
  },
  close: {
    words: [at("close", 0, 1), at("close", 0, 2), at("close", 0, 3)],
    cta: at("close", 1, 0),
    repo: at("close", 1, 1),
  },
} as const;

/** Keystroke frames, shared by the typed text on screen and the key sounds. */
export const TYPING = {
  name: typing(typeName, T.template.typeStart, 3),
  amount: typing(typeAmount, T.paylink.amountStart, 3),
  order: typing(typeOrder, T.paylink.orderStart, 2),
  payTo: typing(typePayTo, T.paylink.payToStart, 2),
};

// ───────── sound effect cues ─────────

export type Sfx =
  | "tap"
  | "touch"
  | "key"
  | "send"
  | "receive"
  | "notify"
  | "webhook"
  | "paid"
  | "tick"
  | "check"
  | "verified"
  | "pop"
  | "whoosh"
  | "swish"
  | "error"
  | "block"
  | "sheet";

export type Cue = { f: number; sfx: Sfx; gain?: number };

const c = (f: number, sfx: Sfx, gain?: number): Cue => ({ f, sfx, gain });

export const CUES: Cue[] = [
  // cover
  c(T.cover.block, "block"),
  c(T.cover.exit, "whoosh"),
  // problem
  c(T.problem.card1, "pop"),
  c(T.problem.error1, "error"),
  c(T.problem.card2, "pop"),
  c(T.problem.error2, "error"),
  c(T.problem.card3, "pop"),
  ...T.problem.pollTicks.map((f) => c(f, "tick", 0.8)),
  c(T.problem.punch, "swish"),
  c(T.problem.exit, "whoosh"),
  // solution
  ...T.solution.blocks.map((f) => c(f, "block", 0.7)),
  ...T.solution.pillars.map((f) => c(f, "pop")),
  c(T.solution.exit, "whoosh"),
  // audience
  ...T.audience.cards.map((f, i) => c(f, "pop", 0.55 + i * 0.03)),
  c(T.audience.focus, "swish"),
  c(T.audience.exit, "whoosh"),
  // 1 sign in
  c(T.signin.tapStart, "tap"),
  c(T.signin.sheet, "sheet"),
  c(T.signin.tapSign, "tap"),
  c(T.signin.dashboard, "swish"),
  // 2 template
  c(T.template.tapTile, "tap"),
  ...TYPING.name.map((f) => c(f, "key")),
  c(T.template.resolved, "check"),
  c(T.template.tapConnect, "tap"),
  // 3 telegram
  c(T.telegram.tapConnect, "tap"),
  c(T.telegram.card, "pop"),
  c(T.telegram.tapOpen, "tap"),
  c(T.telegram.phoneIn, "whoosh", 0.7),
  c(T.telegram.tapStart, "touch"),
  c(T.telegram.tapStart + 2, "send"),
  c(T.telegram.reply, "receive"),
  c(T.telegram.linkedRow, "pop"),
  // 4 alert
  c(T.alert.payment, "swish"),
  c(T.alert.drop, "notify"),
  c(T.alert.bubble, "receive", 0.6),
  c(T.alert.webhook, "webhook"),
  c(T.alert.verified, "check"),
  ...T.alert.delivered.map((f) => c(f, "pop")),
  // 5 payment link
  ...TYPING.amount.map((f) => c(f, "key")),
  ...TYPING.order.map((f) => c(f, "key", 0.8)),
  ...TYPING.payTo.map((f) => c(f, "key", 0.8)),
  c(T.paylink.tapCreate, "tap"),
  c(T.paylink.tapCreate + 4, "pop"),
  c(T.paylink.tapOpen, "tap"),
  c(T.paylink.tapPay, "tap"),
  c(T.paylink.paid, "paid"),
  // 6 traction
  ...Array.from({ length: 12 }, (_, i) => c(T.traction.countStart + i * 4, "tick")),
  c(T.traction.scroll, "swish", 0.6),
  c(T.traction.tapVerify, "tap"),
  ...T.traction.checks.slice(0, 3).map((f) => c(f, "check")),
  c(T.traction.checks[3], "verified"),
  // uses montage
  ...T.uses.starts.map((f) => c(f, "whoosh", 0.75)),
  ...T.uses.starts.map((f, i) => c(f + BEAT, i === 3 ? "paid" : i === 4 || i === 5 ? "receive" : "notify", 0.7)),
  // close
  ...T.close.words.map((f) => c(f, "pop", 0.5)),
];

// ───────── voice-over ─────────

/**
 * One clip per line. `start` is where the clip is placed; it must finish before `end`
 * (the next line or the next section). Drop the Higgsfield recordings in
 * public/vo/<id>.mp3 (or .wav); lines without a recording use the scratch voice.
 */
export type VoLine = { id: string; start: number; end: number; text: string; say?: string };

export const VO: VoLine[] = [
  { id: "01-cover", start: at("cover", 0, 0.75), end: at("cover", 1, 3.5), text: "Q-Pulse. Real-time events for QIE.", say: "Q Pulse. Real-time events for Q I E." },
  {
    id: "02-problem",
    start: at("problem", 0, 0.5),
    end: at("problem", 4, 3.5),
    text: "On QIE, nothing tells your app when something happens. No subscriptions, no webhooks. So teams babysit polling loops, and shops keep refreshing.",
    say: "On Q I E, nothing tells your app when something happens. No subscriptions, no webhooks. So teams babysit polling loops, and shops keep refreshing.",
  },
  {
    id: "03-solution",
    start: at("solution", 0, 0.5),
    end: at("solution", 2, 3.5),
    text: "Q-Pulse reads every block, once, for everyone, and tells you the moment it matters.",
    say: "Q Pulse reads every block, once, for everyone, and tells you the moment it matters.",
  },
  {
    id: "04-audience",
    start: at("audience", 0, 0.5),
    end: at("audience", 3, 3.5),
    text: "It's built for shops, communities, traders, project teams, developers and AI agents. Let's follow a shop.",
  },
  { id: "05-signin", start: at("signin", 0, 0.5), end: at("signin", 2, 3.5), text: "Sign in with your QIE wallet. One signature, no gas.", say: "Sign in with your Q I E wallet. One signature, no gas." },
  {
    id: "06-template",
    start: at("template", 0, 0.5),
    end: at("template", 3, 3.5),
    text: "Pick a template, like payments to your .qie name. Type it, and it resolves on chain.",
    say: "Pick a template, like payments to your dot Q I E name. Type it, and it resolves on chain.",
  },
  {
    id: "07-telegram",
    start: at("telegram", 0, 0.5),
    end: at("telegram", 2, 3.5),
    text: "Connect Telegram. Send your one-time code to the Q-Pulse bot, and you're linked.",
    say: "Connect Telegram. Send your one-time code to the Q Pulse bot, and you're linked.",
  },
  { id: "08-alert-a", start: at("alert", 0, 0.5), end: at("alert", 1, 0), text: "A customer pays." },
  {
    id: "08-alert-b",
    start: at("alert", 1, 1.5),
    end: at("alert", 3, 3.5),
    text: "Your phone buzzes. Your server gets a signed webhook. Seconds after the block.",
  },
  {
    id: "09-paylink",
    start: at("paylink", 0, 0.5),
    end: at("paylink", 2, 3.5),
    text: "Need an exact amount? Send a payment link. It turns paid by itself.",
  },
  {
    id: "10-traction",
    start: at("traction", 0, 0.5),
    end: at("traction", 2, 3.5),
    text: "Then prove your traction: real numbers, committed on chain daily, that anyone can verify.",
  },
  { id: "11-uses-communities", start: at("uses", 0, 0.25), end: at("uses", 1, 0), text: "Communities get whale alerts." },
  { id: "12-uses-traders", start: at("uses", 1, 0.25), end: at("uses", 2, 0), text: "Traders get a rug-pull radar." },
  { id: "13-uses-holders", start: at("uses", 2, 0.25), end: at("uses", 3, 0), text: "Holders get scam warnings." },
  { id: "14-uses-sellers", start: at("uses", 3, 0.25), end: at("uses", 4, 0), text: "Sellers get QR checkouts." },
  { id: "15-uses-developers", start: at("uses", 4, 0.25), end: at("uses", 5, 0), text: "Developers get subscriptions." },
  { id: "16-uses-agents", start: at("uses", 5, 0.25), end: at("close", 0, 0), text: "AI agents take payments." },
  {
    id: "17-close",
    start: at("close", 0, 0.5),
    end: at("close", 3, 3),
    text: "Q-Pulse. Watch. Alert. Prove. Start free today.",
    say: "Q Pulse. Watch. Alert. Prove. Start free today.",
  },
];

// ───────── drift guard ─────────

/** FNV-1a over everything the soundtrack depends on. */
export function timelineHash(): string {
  const s = JSON.stringify({ FPS, BPM, SECTIONS, CUES, VO });
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
