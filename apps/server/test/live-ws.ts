// Manual check against QIE mainnet: node test/live-ws.ts
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { createPublicClient, webSocket } from "viem";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildApp, buildServices } from "../src/main.ts";
import { attachWebSocket } from "../src/stream.ts";

const s = buildServices(loadConfig({ DB_PATH: ":memory:", QIE_NETWORK: "mainnet", POLL_INTERVAL_MS: "500" } as NodeJS.ProcessEnv), { db: openDb(":memory:") });
const server = serve({ fetch: buildApp(s).fetch, port: 0 }) as Server;
await new Promise((r) => server.once("listening", r));
const ws = attachWebSocket(server, s.gateway, s.rpcLimiter, "");
const port = (server.address() as { port: number }).port;
const client = createPublicClient({ transport: webSocket(`ws://127.0.0.1:${port}/rpc`) });
console.log("chainId", await client.getChainId(), "head", await client.getBlockNumber());
const seen: string[] = [];
const unwatch = client.watchBlocks({
  onBlock: (b) => {
    const lag = Date.now() - Number(b.timestamp) * 1000;
    seen.push(`#${b.number} ${b.hash.slice(0, 10)} tx=${b.transactions.length} lag=${lag}ms`);
    console.log("newHeads", seen.at(-1));
  },
});
const unlogs = client.watchEvent({ onLogs: (ls) => console.log("logs", ls.length, ls.map((l) => l.address).join(",")) });
await new Promise((r) => setTimeout(r, 20_000));
unwatch();
unlogs();
console.log("stream latency", JSON.stringify(s.metrics.stats("stream")));
ws.close();
s.stream.stop();
s.gateway.stop();
server.close();
process.exit(0);
