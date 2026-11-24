import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { pad } from "viem";
import { QIE_MAINNET, TOPIC, type RpcLog, type RpcTx } from "../src/chain.ts";
import { loadConfig } from "../src/config.ts";
import { openDb, type Db } from "../src/db.ts";
import { buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";

const OWNER = "0x1111111111111111111111111111111111111111";
const BUYER = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"a".repeat(64)}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const dbs: Db[] = [];
const services: ReturnType<typeof buildServices>[] = [];
function setup() {
  const cfg = loadConfig({ DB_PATH: ":memory:", PUBLIC_URL: "https://app.example", RPC_URLS: "http://127.0.0.1:1", QIEDEX_API_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv);
  const db = openDb(":memory:"); dbs.push(db);
  const s = buildServices(cfg, { db, names: new StaticNameResolver({}) }); services.push(s);
  const user = { id: "usr_audit", address: OWNER };
  db.prepare("INSERT INTO users (id,address,created_at) VALUES (?,?,?)").run(user.id, user.address, Math.floor(Date.now()/1000));
  return {s,db,user};
}
function transfer(amount: string, txHash = HASH, logIndex = 0): RpcLog {
 return { address: QIE_MAINNET.QUSDC, topics:[TOPIC.TRANSFER,pad(BUYER),pad(OWNER)],data:pad(hex(BigInt(amount)) as `0x${string}`),blockNumber:"0x64",transactionHash:txHash,transactionIndex:"0x0",logIndex:hex(logIndex),blockHash:hash(5) } as RpcLog;
}
function native(amount: string): RpcTx {
 return { hash:HASH,from:BUYER,to:OWNER,value:hex(BigInt(amount)),blockNumber:"0x64",transactionIndex:"0x0",input:"0x" } as RpcTx;
}
afterEach(()=>{for(const s of services.splice(0))s.rpc.stop();for(const db of dbs.splice(0))db.close();});
describe("payment settlement audit",()=>{
 it("cannot reuse an ERC-20 transfer to pay a second invoice after the amount is reused",async()=>{
  const {s,user}=setup();const first=await s.invoices.create(user,{amount:"5"});const log=transfer(first.amount.raw);
  assert.equal(await s.invoices.matchLog(log,Math.floor(Date.now()/1000)),first.id);
  const second=await s.invoices.create(user,{amount:"5"});assert.equal(second.amount.raw,first.amount.raw);
  assert.equal(await s.invoices.matchLog(log,Math.floor(Date.now()/1000)),null);
  assert.equal(s.invoices.get(user.id,second.id).status,"open");
  assert.equal(await s.invoices.matchLog(transfer(second.amount.raw,hash(2)),Math.floor(Date.now()/1000)),second.id);
 });
 it("cannot reuse a native transfer to pay a second invoice",async()=>{
  const {s,user}=setup();const first=await s.invoices.create(user,{amount:"5",token:"QIE"});const transfer=native(first.amount.raw);
  assert.equal(await s.invoices.matchNative(transfer,Math.floor(Date.now()/1000)),first.id);
  const second=await s.invoices.create(user,{amount:"5",token:"QIE"});assert.equal(second.amount.raw,first.amount.raw);
  assert.equal(await s.invoices.matchNative(transfer,Math.floor(Date.now()/1000)),null);
  assert.equal(s.invoices.get(user.id,second.id).status,"open");
 });
 it("still accepts distinct transfer logs in the same transaction",async()=>{
  const {s,user}=setup();const first=await s.invoices.create(user,{amount:"5"});
  await s.invoices.matchLog(transfer(first.amount.raw,HASH,0),Math.floor(Date.now()/1000));
  const second=await s.invoices.create(user,{amount:"5"});
  assert.equal(await s.invoices.matchLog(transfer(second.amount.raw,HASH,1),Math.floor(Date.now()/1000)),second.id);
 });
 it("rolls payment and product sale back when queuing its notification fails, then retries once",async()=>{
  const {s,db,user}=setup();const product=await s.products.create(user,{name:"File",amount:"5",unlockContent:"private-download"});
  const inv=await s.products.buy(product.id);
  db.prepare("INSERT INTO hooks(id,user_id,name,trigger_type,trigger_config,channel_type,channel_config,secret,created_at,updated_at) VALUES (?,?,?,'invoice','{}','webhook',?,'test',?,?)").run('hk_audit',user.id,'orders',JSON.stringify({url:'https://example.com/hook'}),1,1);
  db.exec("CREATE TRIGGER audit_fail_outbox BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT,'audit outbox failure'); END;");
  await assert.rejects(s.invoices.matchLog(transfer(inv.amount.raw),Math.floor(Date.now()/1000)),/audit outbox failure/);
  assert.equal(s.invoices.get(user.id,inv.id).status,"open");
  assert.equal(s.products.get(user.id,product.id).sold,0);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events").get() as {n:number}).n,0);
  db.exec("DROP TRIGGER audit_fail_outbox");
  assert.equal(await s.invoices.matchLog(transfer(inv.amount.raw),Math.floor(Date.now()/1000)),inv.id);
  assert.equal(s.products.get(user.id,product.id).sold,1);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as {n:number}).n,1);
 });
});
