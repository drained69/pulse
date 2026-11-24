import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ensureUser } from "../src/billing.ts";
import { loadConfig } from "../src/config.ts";
import { openDb } from "../src/db.ts";
import { buildServices } from "../src/main.ts";
import { StaticNameResolver } from "../src/names.ts";
const cleanup:(()=>void)[]=[];
afterEach(()=>{for(const f of cleanup.splice(0))f();});
function fixture(){
 const cfg=loadConfig({DB_PATH:':memory:',PUBLIC_URL:'https://app.example',RPC_URLS:'http://127.0.0.1:1',FREE_MAX_HOOKS:'2'} as NodeJS.ProcessEnv);
 const db=openDb(':memory:');const s=buildServices(cfg,{db,names:new StaticNameResolver({})});cleanup.push(()=>{s.rpc.stop();db.close();});
 const user=ensureUser(db,'0x1111111111111111111111111111111111111111');return {s,db,user};
}
describe('audit: concurrent resource quotas',()=>{
 it('enforces the hook plan cap after asynchronous validation',async()=>{
  const {s,db,user}=fixture();
  db.prepare("INSERT INTO telegram_chats(id,user_id,chat_id,title,chat_type,created_at) VALUES ('chat_audit',?,'42','Audit','private',0)").run(user.id);
  const results=await Promise.allSettled(Array.from({length:3},(_,i)=>s.hooks.create(user,{name:`Hook ${i}`,trigger:{type:'invoice',config:{}},channel:{type:'telegram',config:{chatRef:'chat_audit'}}})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM hooks').get() as {n:number}).n,2);
 });
 it('enforces the project cap after asynchronous ownership checks',async()=>{
  const {s,db,user}=fixture();s.cfg.maxProjects=2;
  s.rpc.batch=async()=>["0x6080"] as never;
  s.projects.verifyOwner=async()=>null;
  s.projects.backfill=async()=>{};
  const results=await Promise.allSettled(Array.from({length:3},(_,i)=>s.projects.create(user,{name:`Project ${i}`,contracts:['0x3333333333333333333333333333333333333333']})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as {n:number}).n,2);
 });
 it('keeps the 50-product cap under concurrent creation',async()=>{
  const {s,db,user}=fixture();
  const results=await Promise.allSettled(Array.from({length:51},(_,i)=>s.products.create(user,{name:`Product ${i}`,amount:'5'})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,50);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM products').get() as {n:number}).n,50);
 });
 it('keeps the per-product checkout cap under simultaneous public purchases',async()=>{
  const {s,db,user}=fixture();const product=await s.products.create(user,{name:'File',amount:'5'});
  const results=await Promise.allSettled(Array.from({length:101},()=>s.products.buy(product.id)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,100);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE product_id=?').get(product.id) as {n:number}).n,100);
 });
});
