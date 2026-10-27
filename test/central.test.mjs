import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {scryptSync,randomUUID} from 'node:crypto';
import {getDb} from '../lib/db.mjs';
import {createService,digest} from '../lib/service.mjs';
import {createAccounts} from '../lib/accounts.mjs';
import {DEFAULT_PARTIES} from '../lib/election.mjs';

test('central results: approved name mapping, all-group locking, correction and legacy preservation',async()=>{
 const dir=await mkdtemp(tmpdir()+'/ballot-central-');process.env.LOCAL_DB_PATH=dir+'/db';
 process.env.ADMIN_PASSWORD_HASH='scrypt$central$'+scryptSync('central-password','central',64).toString('hex');
 const db=await getDb();
 try{
  const root=createService(db),admin={admin:(await root.login({password:'central-password'},'root')).token};
  const accounts=createAccounts(db),owner=(await accounts.register({username:'Owner',password:'1234',passwordConfirm:'1234'},'owner')).token;
  const created=await accounts.createGroup({title:'חדשה'},owner,'owner');
  const row=(await db.query('SELECT * FROM ballot_game WHERE slug=$1',[created.slug])).rows[0],group=createService(db,{groupId:row.id});
  const ownerAuth={account:owner};
  let s=await group.read(ownerAuth);
  assert.deepEqual(s.parties,DEFAULT_PARTIES);assert.equal(new Date(s.deadline).toISOString(),'2026-10-26T22:05:00.000Z');
  assert.equal(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Jerusalem',hour:'2-digit',minute:'2-digit'}).format(new Date(s.deadline)),'00:05');
  assert.equal(s.fixedParties,true);assert.equal(s.isCentralAdmin,false);
  await assert.rejects(()=>group.configure({version:s.version,title:'חדשה',parties:['x','y'],deadline:s.deadline},ownerAuth),e=>e.status===403);
  await group.configure({version:s.version,title:'חדשה',parties:s.parties,deadline:new Date(Date.now()+86400000).toISOString()},ownerAuth);
  const player=await group.join({name:'חדשה'},'player');s=await group.read();
  const actual=DEFAULT_PARTIES.map(()=>0);actual[8]=10;actual[9]=110;
  await group.predict({version:s.version,prediction:actual},{player:player.token});
  // Simulate existing data: different order, previously entered aliases, and an unrecognized name.
  const legacy=(await db.query('INSERT INTO ballot_game(slug,title,parties,configured,locked,deadline) VALUES($1,$2,$3,true,false,$4) RETURNING id',
   ['l'.repeat(24),'ישנה',JSON.stringify(['הציונות הדתית','ש״ס','שם לבדיקה']),new Date(Date.now()+86400000).toISOString()])).rows[0];
  const old=createService(db,{groupId:legacy.id}),oldPlayer=await old.join({name:'ישנה'},'old');
  await old.predict({version:(await old.read()).version,prediction:[110,10,0]},{player:oldPlayer.token});
  // Legacy sessions can administer their group but cannot edit the slate or publish.
  const legacyToken='legacy-token';
  await db.query('INSERT INTO ballot_admin_sessions(token_hash,group_id,expires_at) VALUES($1,$2,$3)',[digest(legacyToken),legacy.id,new Date(Date.now()+3600000).toISOString()]);
  const legacyAuth={admin:legacyToken};
  const oldState=await old.read(legacyAuth);assert.equal(oldState.fixedParties,true);
  await assert.rejects(()=>old.configure({version:oldState.version,title:'ישנה',parties:['x','y'],deadline:oldState.deadline},legacyAuth),e=>e.status===403);
  await assert.rejects(()=>old.results({},legacyAuth),e=>e.status===403);
  await assert.rejects(()=>group.results({},ownerAuth),e=>e.status===403);
  await assert.rejects(()=>root.results({},ownerAuth),e=>e.status===403);
  let editor=(await root.read(admin)).central;
  assert.equal(editor.groupCount,3);
  assert.equal(editor.mappings.find(m=>m.source==='הציונות הדתית').target,'הציונות הדתית + זהות');
  assert.equal(editor.mappings.find(m=>m.source==='ש״ס').target,'ש"ס');
  assert.equal(editor.mappings.find(m=>m.source==='שם לבדיקה').target,'');
  assert.deepEqual(editor.mappings.find(m=>m.source==='שם לבדיקה').groups.map(g=>g.title),['ישנה']);
  let payload={electionVersion:editor.version,parties:editor.parties,actual,mapping:editor.mappings};
  await assert.rejects(()=>root.results(payload,admin),e=>e.status===400);
  assert.equal((await group.read()).published,false);
  payload.mapping=payload.mapping.map(m=>({...m,target:m.target===''?null:m.target}));
  await assert.rejects(()=>root.saveMapping(payload,ownerAuth),e=>e.status===403);
  await root.saveMapping(payload,admin);
  assert.equal((await group.read()).closed,false);
  assert.equal((await group.read()).published,false);
  payload.electionVersion=(await root.read(admin)).central.version;
  assert.equal((await root.read(admin)).central.mappings.find(m=>m.source==='שם לבדיקה').target,null);
  await assert.rejects(()=>root.results({...payload,actual:[1]},admin),e=>e.status===400);
  // Publishing and a submission serialize. A publish started first closes every group.
  const outcomes=await Promise.allSettled([root.results(payload,admin),group.predict({version:s.version,prediction:actual},{player:player.token})]);
  assert.equal(outcomes[0].status,'fulfilled');assert.equal(outcomes[1].status,'rejected');assert.equal(outcomes[1].reason.status,409);
  const a=await group.read(),b=await old.read();
  assert.equal(a.published,true);assert.equal(b.published,true);assert.equal(a.closed,true);assert.equal(b.closed,true);
  assert.equal(a.scoreboard[0].score,120);assert.equal(b.scoreboard[0].score,120);
  assert.deepEqual(b.unmatchedParties,['שם לבדיקה']);
  assert.deepEqual(b.scoreboard[0].prediction,[...actual,0]);
  // Source rows are never rewritten by name projection or result corrections.
  const stored=(await db.query('SELECT prediction FROM ballot_players WHERE id=$1',[oldPlayer.id])).rows[0].prediction;
  assert.deepEqual(stored,[110,10,0]);
  assert.deepEqual((await db.query('SELECT parties FROM ballot_game WHERE id=$1',[legacy.id])).rows[0].parties,['הציונות הדתית','ש״ס','שם לבדיקה']);
  await assert.rejects(()=>group.lock({version:a.version,locked:false},ownerAuth),e=>e.status===409);
  await assert.rejects(()=>group.configure({version:a.version,title:'changed',parties:DEFAULT_PARTIES,deadline:s.deadline},ownerAuth),e=>e.status===409);
  await assert.rejects(()=>root.results(payload,admin),e=>e.status===409);
  editor=(await root.read(admin)).central;
  const corrected=actual.slice();corrected[8]=11;corrected[9]=109;
  await root.results({...payload,electionVersion:editor.version,actual:corrected},admin);
  assert.equal((await group.read()).scoreboard[0].score,119);assert.equal((await old.read()).scoreboard[0].score,119);
  assert.equal((await db.query("SELECT count(*) AS n FROM ballot_audit WHERE action='central_correct_results'")).rows[0].n,1);
  const late=await accounts.createGroup({title:'אחרי הפרסום'},owner,'owner');
  const lateId=(await db.query('SELECT id FROM ballot_game WHERE slug=$1',[late.slug])).rows[0].id;
  const lateService=createService(db,{groupId:lateId}),lateState=await lateService.read();
  assert.equal(lateState.published,true);assert.deepEqual(lateState.actual,corrected);
  await assert.rejects(()=>lateService.join({name:'מאוחר'},'late'),e=>e.status===409);
 }finally{await db.close();await rm(dir,{recursive:true,force:true});}
});
