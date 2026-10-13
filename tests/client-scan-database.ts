import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { orderDatabase, adminId, salesId } from "./order-backend.mjs";
import { syntheticProfile, syntheticObservation } from "./scan-fit-fixtures";
import { analyse, aggregate } from "../src/lib/scan-fit/geometry";
import { DEFAULT_CONFIG } from "../src/lib/scan-fit/model";

const { db, request } = await orderDatabase({ scanFit: true, clientScan: true });
const customer = randomUUID();
await db.query("insert into public.customers(id,first_name,last_name,assigned_to) values($1,'Remote','Client',$2)", [customer,salesId]);
async function service(sql: string, args: unknown[] = []) {
  return db.transaction(async tx => { await tx.exec("set local role service_role"); return (await tx.query<{ value: Record<string,unknown> }>(sql,args)).rows; });
}
const profile = (await service("select public.scan_fit_operate($1,'profile',$2::jsonb) value", [adminId,JSON.stringify(syntheticProfile)]))[0].value as { id: string };
let counter=0;
async function issue(actor=adminId, expired=false) {
  const hash=createHash('sha256').update('test-token-'+counter++).digest('hex');
  const receipt = (await service("select public.scan_fit_issue_client_link($1,$2::jsonb) value", [actor,JSON.stringify({ customer_id:customer,order_id:'',profile_id:profile.id,token_hash:hash,expires_at:new Date(Date.now()+(expired?-10000:3600000)).toISOString() })]))[0].value as { session_id: string };
  return { hash, id: receipt.session_id };
}
async function authorize(hash: string, operation='status', payload: unknown={}) {
  return (await service("select public.scan_fit_client_authorize($1,$2,$3::jsonb) value",[hash,operation,JSON.stringify(payload)]))[0].value as { state: string; session: {id:string;customer_id:string;capture_source:string} };
}
try {
  await test('anonymous clients cannot read token hashes or invoke privileged RPCs directly', async () => {
    await assert.rejects(()=>request('select * from public.scan_fit_client_links',[],null),/permission denied/);
    await assert.rejects(()=>request("select public.scan_fit_client_authorize('invalid','status','{}')",[],null),/permission denied/);
    await assert.rejects(()=>request('select * from public.scan_fit_client_links'),/permission denied/);
  });
  await test('issued link binds to one CRM customer and marks remote capture provenance', async () => {
    const link=await issue();const status=await authorize(link.hash);
    assert.equal(status.session.id,link.id);assert.equal(status.session.customer_id,customer);assert.equal(status.session.capture_source,'remote_client');
    assert.equal((await db.query<{token_hash:string}>('select token_hash from public.scan_fit_client_links where session_id=$1',[link.id])).rows[0].token_hash,link.hash);
  });
  await test('invalid, expired, revoked and deactivated-issuer links are rejected', async () => {
    await assert.rejects(()=>authorize('0'.repeat(64)),/unavailable/);
    await assert.rejects(()=>issue(adminId,true),/expiry/);
    const expired=await issue();await db.query("update public.scan_fit_client_links set expires_at=now()-interval '1 second' where session_id=$1",[expired.id]);await assert.rejects(()=>authorize(expired.hash),/unavailable/);
    const revoked=await issue();await service('select public.scan_fit_revoke_client_link($1,$2)',[adminId,revoked.id]);await assert.rejects(()=>authorize(revoked.hash),/unavailable/);
    const inactive=await issue(salesId);await db.query('update public.users set active=false where id=$1',[salesId]);await assert.rejects(()=>authorize(inactive.hash),/unavailable/);await db.query('update public.users set active=true where id=$1',[salesId]);
  });
  await test('a client cannot submit to another session or omit explicit consent', async () => {
    const link=await issue();
    await assert.rejects(()=>authorize(link.hash,'submit',{session_id:randomUUID(),consent:true,consent_version:'remote-capture/1'}),/Invalid submission/);
    await assert.rejects(()=>authorize(link.hash,'submit',{session_id:link.id}),/Invalid submission/);
  });
  await test('one atomic submission persists private frames into CRM Review with no order write and idempotent receipt', async () => {
    const link=await issue();const frames=[];
    for(let i=0;i<5;i++) {
      const observation=syntheticObservation(i);const analysis=analyse(observation,syntheticProfile,DEFAULT_CONFIG);
      const prefix=`${customer}/${link.id}/${randomUUID()}`;
      const paths={original_path:prefix+'-original.jpg',annotated_path:prefix+'-annotated.jpg',rectified_path:prefix+'-rectified.jpg'};
      for(const path of Object.values(paths)) await db.query("insert into storage.objects(bucket_id,name) values('scan-fit',$1)",[path]);
      frames.push({frame_index:i,observation,analysis,...paths,image_sha256:createHash('sha256').update(prefix).digest('hex')});
    }
    const payload={session_id:link.id,consent:true,consent_version:'remote-capture/1',frames,result:aggregate(frames.map(f=>f.analysis),DEFAULT_CONFIG)};
    assert.equal((await authorize(link.hash,'submit',payload)).state,'submitted');
    assert.equal((await authorize(link.hash,'submit',payload)).state,'submitted');
    const session=(await db.query<{status:string;accepted_at:string|null}>('select status,accepted_at from public.scan_fit_sessions where id=$1',[link.id])).rows[0];assert.equal(session.status,'Review');assert.equal(session.accepted_at,null);
    assert.equal((await db.query<{n:number}>('select count(*)::integer n from public.scan_fit_frames where session_id=$1',[link.id])).rows[0].n,5);
    assert.equal((await db.query<{n:number}>('select count(*)::integer n from public.measurements')).rows[0].n,0);
    const receipt=await authorize(link.hash);assert.deepEqual(receipt.session,{id:link.id});
    assert.equal((await db.query<{consent_version:string}>('select consent_version from public.scan_fit_client_links where session_id=$1',[link.id])).rows[0].consent_version,'remote-capture/1');
  });
} finally { await db.close(); }
