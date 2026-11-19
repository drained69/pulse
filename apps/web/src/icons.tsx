/** Line icons (24×24, stroke = currentColor) so every icon matches the type and the theme. */
const PATHS: Record<string, string> = {
  incoming: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M12 8v8 M8.5 12.5 12 16l3.5-3.5",
  transfer: "M4 8h15 M15 4l4 4-4 4 M20 16H5 M9 12l-4 4 4 4",
  swap: "M19.5 13.5A8 8 0 0 1 5.6 17 M4.5 10.5A8 8 0 0 1 18.4 7 M18.5 3v4.2h-4.2 M5.5 21v-4.2h4.2",
  megaphone: "M3 10v4h3l8 4.5V5.5L6 10z M17.5 9a4 4 0 0 1 0 6",
  wallet: "M4 7.5h15a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 19.5H5A1.5 1.5 0 0 1 3.5 18V6.5A2 2 0 0 1 5.5 4.5h11 M16 13.5h1.5",
  battery: "M3.5 8h14v8h-14z M20.5 11v2 M6.5 11v2",
  trending: "M3 17l6-6 4 4 8-8 M15 7h6v6",
  id: "M3.5 6h17v12h-17z M7.5 15.2c.5-1.4 1.5-2 2.8-2s2.3.6 2.8 2 M10.3 11a1.6 1.6 0 1 0 0-3.2a1.6 1.6 0 0 0 0 3.2z M15.5 10h2.5 M15.5 13h2.5",
  calendar: "M4 6h16v14H4z M4 10h16 M8.5 3.5v4 M15.5 3.5v4",
  receipt: "M6 3.5h12v17l-2.4-1.5-2.4 1.5-2.4-1.5-2.4 1.5L6 20.5z M9 8.5h6 M9 12h6 M9 15.5h3",
  bag: "M5.5 8h13l-1 12.5h-11z M9 8V6.5a3 3 0 0 1 6 0V8",
  shield: "M12 3l7.5 3v5.5c0 4.8-3.2 8.2-7.5 9.5-4.3-1.3-7.5-4.7-7.5-9.5V6z",
  alert: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M12 7.5v5.5 M12 16.2v.3",
  lock: "M5.5 11h13v9.5h-13z M8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  unlock: "M5.5 11h13v9.5h-13z M8.5 11V8a3.5 3.5 0 0 1 6.8-1.2",
  waves: "M3 14c2.2 0 2.2-2 4.5-2s2.3 2 4.5 2 2.2-2 4.5-2 2.3 2 4.5 2 M3 19c2.2 0 2.2-2 4.5-2s2.3 2 4.5 2 2.2-2 4.5-2 2.3 2 4.5 2 M12 3.5v6 M9 7l3 3 3-3",
  plus: "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M12 8v8 M8 12h8",
  zap: "M13 2.5 4.5 14H11l-1 7.5L18.5 10H12z",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1 M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  send: "M21 3 3 10.5l7 2.5 2.5 7.5z M10 13l11-10",
  chat: "M4 5h16v11H9.5L4 20z M8.5 9.5h7 M8.5 12.5h4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  sun: "M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8z M12 2.5v2 M12 19.5v2 M2.5 12h2 M19.5 12h2 M5.3 5.3l1.4 1.4 M17.3 17.3l1.4 1.4 M5.3 18.7l1.4-1.4 M17.3 6.7l1.4-1.4",
  moon: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z",
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className, title }: { name: string; size?: number; className?: string; title?: string }) {
  const d = PATHS[name] ?? PATHS.zap!;
  return (
    <svg
      className={`icon ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={d} />
    </svg>
  );
}
