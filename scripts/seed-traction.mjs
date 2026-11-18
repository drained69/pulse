#!/usr/bin/env node
// Create traction pages for the projects in scripts/traction-targets.json on your deployed QIE Hooks.
// The teams can then claim their page by signing in with their deployer wallet.
//
//   QIEHOOKS_URL=https://your-app QIEHOOKS_KEY=qh_live_… node scripts/seed-traction.mjs
import { readFileSync } from "node:fs";

const base = (process.env.QIEHOOKS_URL ?? "").replace(/\/$/, "");
const key = process.env.QIEHOOKS_KEY ?? "";
if (!base || !key.startsWith("qh_")) {
  console.error("Set QIEHOOKS_URL and QIEHOOKS_KEY (an API key from the dashboard).");
  process.exit(1);
}
const { projects } = JSON.parse(readFileSync(new URL("./traction-targets.json", import.meta.url), "utf8"));
for (const p of projects) {
  const res = await fetch(`${base}/api/my/projects`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ name: p.name, slug: p.slug, description: p.description, website: p.repo, contracts: p.contracts }),
  });
  const json = await res.json().catch(() => ({}));
  if (res.ok) console.log(`✔ ${p.name}: ${base}/#/p/${json.project.slug}`);
  else console.log(`✖ ${p.name}: ${res.status} ${json.error ?? ""}`);
}
console.log(`\nLeaderboard: ${base}/#/explore`);
