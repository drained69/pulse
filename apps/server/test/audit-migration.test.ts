import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { openDb, tx, type Db } from "../src/db.ts";

it("preserves historical paid transactions when installing the payment replay ledger",()=>{
 const dir=mkdtempSync(join(tmpdir(),'qpulse-migration-'));let db:Db|null=null;
 try{
  const file=join(dir,'legacy.db');db=openDb(file);
  db.prepare("INSERT INTO users(id,address,created_at) VALUES ('u','0x1111111111111111111111111111111111111111',0)").run();
  db.prepare("INSERT INTO invoices(id,user_id,recipient,token,symbol,decimals,amount_raw,base_amount_raw,expires_at,created_at,status,paid_tx) VALUES ('inv_legacy','u','0x1111111111111111111111111111111111111111','native','QIE',18,'1','1',100,0,'paid','0xABCD')").run();
  // Recreate the immediately preceding persisted schema, then reopen as an upgrade.
  db.exec('DROP TABLE invoice_payments; UPDATE schema_version SET version=version-1');
  db.close();db=null;db=openDb(file);
  assert.ok(db.prepare("SELECT 1 FROM invoice_payments WHERE payment_key='legacy:0xabcd'").get());
  db.prepare("DELETE FROM users WHERE id='u'").run();
  const seen=db.prepare("SELECT invoice_id FROM invoice_payments WHERE payment_key='legacy:0xabcd'").get() as {invoice_id:string|null};
  assert.equal(seen.invoice_id,null,'deleting an account must not make its historical transfers reusable');
 }finally{db?.close();rmSync(dir,{recursive:true,force:true});}
});
it("rolls back nested settlement/outbox work together, while allowing an inner rollback to be caught",()=>{
 const db=openDb(':memory:');
 try{
  db.exec('CREATE TABLE audit_values(n INTEGER)');
  assert.throws(()=>tx(db,()=>{db.prepare('INSERT INTO audit_values VALUES (1)').run();tx(db,()=>{db.prepare('INSERT INTO audit_values VALUES (2)').run();});throw new Error('outer failure');}),/outer failure/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM audit_values').get() as {n:number}).n,0);
  tx(db,()=>{db.prepare('INSERT INTO audit_values VALUES (3)').run();try{tx(db,()=>{db.prepare('INSERT INTO audit_values VALUES (4)').run();throw new Error('inner failure');});}catch{}db.prepare('INSERT INTO audit_values VALUES (5)').run();});
  assert.deepEqual(db.prepare('SELECT n FROM audit_values ORDER BY n').all().map(r=>r.n),[3,5]);
 }finally{db.close();}
});
