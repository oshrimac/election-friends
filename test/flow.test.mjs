import {DEFAULT_PARTIES} from '../lib/election.mjs';
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {scryptSync} from 'node:crypto';
import {getDb} from '../lib/db.mjs';
import {createService,scoreboard,digest} from '../lib/service.mjs';
import {createServer} from '../server.mjs';
const dir=await mkdtemp(tmpdir()+'/ballot-test-');
process.env.LOCAL_DB_PATH=dir+'/db';
process.env.ADMIN_PASSWORD_HASH='scrypt$test-salt$'+scryptSync('a test password of 24 chars','test-salt',64).toString('hex');
const db=await getDb();let now=Date.now();const svc=createService(db,{clock:()=>now});let admin,p1,p2;
after(async()=>{await db.close();await rm(dir,{recursive:true,force:true});});
const padded=v=>[...v,...Array(DEFAULT_PARTIES.length-v.length).fill(0)];
const central=async(body,auth)=>{
 const editor=(await svc.read(auth)).central;
 return svc.results({...body,actual:padded(body.actual),parties:editor.parties,electionVersion:editor.version,mapping:editor.mappings},auth);
};
const rejected=(fn,status)=>assert.rejects(fn,e=>e.status===status);
test('full group lifecycle, participant privacy, admin authority, result correction and audit',async()=>{
 let s=await svc.read();assert.equal(s.configured,false);assert.equal(s.closed,true);
 await rejected(()=>svc.configure({},{admin:'fake'}),401);
 await rejected(()=>svc.login({password:'wrong'},'login'),401);
 admin={admin:(await svc.login({password:'a test password of 24 chars'},'login')).token};
 await svc.configure({version:s.version,title:'החברים',parties:DEFAULT_PARTIES,deadline:new Date(now+3600000).toISOString()},admin);
 s=await svc.read();assert.equal(s.closed,false);assert.deepEqual(s.players,[]);
 p1=await svc.join({name:'נועם'},'p1');p2=await svc.join({name:'מיה'},'p2');assert.equal(p1.token.length,43);
 await rejected(()=>svc.join({name:'נועם'},'p3'),409);
 await rejected(()=>svc.predict({version:s.version,prediction:padded([60,50,10])},{player:'fake'}),401);
 for(const v of [[60,50,9],[60.5,49.5,10],[-1,111,10],[120,0],['60',50,10]]) await rejected(()=>svc.predict({version:s.version,prediction:v},{player:p1.token}),400);
 await svc.predict({version:s.version,prediction:padded([60,50,10])},{player:p1.token});
 await svc.predict({version:s.version,prediction:padded([58,52,10])},{player:p2.token});
 s=await svc.read({player:p1.token});assert.deepEqual(s.me.prediction,padded([60,50,10]));assert.equal(s.players[1].prediction,undefined);assert.equal(s.actual,null);assert.deepEqual(s.scoreboard,[]);
 await rejected(()=>svc.configure({version:s.version,title:'x',parties:['א','ב'],deadline:s.deadline},admin),403);
 await rejected(()=>svc.results({version:s.version,actual:[60,50,10]},admin),409);
 await rejected(()=>svc.lock({version:s.version,locked:true},{}),401);
 // Updating someone else's id cannot change the owner selected by the session.
 await svc.predict({version:s.version,prediction:padded([61,49,10]),id:p2.id},{player:p1.token});
 assert.deepEqual((await svc.read({player:p2.token})).me.prediction,padded([58,52,10]));
 await svc.lock({version:s.version,locked:true},admin);s=await svc.read();
 assert.equal(s.closed,true);assert.ok(s.players.every(p=>p.prediction));
 await rejected(()=>svc.predict({version:s.version,prediction:padded([60,50,10])},{player:p1.token}),409);
 await central({actual:[60,50,10],note:'תוצאות רשמיות לבדיקה'},admin);
 s=await svc.read();assert.equal(s.published,true);assert.deepEqual(s.scoreboard.map(p=>[p.name,p.score,p.rank]),[['נועם',119,1],['מיה',118,2]]);
 await rejected(()=>svc.lock({version:s.version,locked:false},admin),409);
 await central({actual:[59,51,10],note:'תיקון'},admin);
 s=await svc.read();assert.deepEqual(s.scoreboard.map(p=>p.score),[119,118]);assert.equal(s.scoreboard[0].name,'מיה');
 assert.equal((await svc.recover({token:p1.token},'recovery')).token,p1.token);
 await rejected(()=>svc.recover({token:'invalid'},'recovery'),401);
 const stored=(await db.query('SELECT token_hash FROM ballot_players WHERE id=$1',[p1.id])).rows[0];assert.equal(stored.token_hash,digest(p1.token));assert.notEqual(stored.token_hash,p1.token);
 assert.equal((await db.query('SELECT count(*) AS n FROM ballot_audit')).rows[0].n,4);
 await svc.logout(admin);await rejected(()=>svc.results({version:s.version,actual:[60,50,10]},admin),403);
});
test('ties share competition rank; perfect and opposite predictions score 120 and 0',()=>{
 const rows=scoreboard([{id:'1',name:'a',prediction:[120,0]},{id:'2',name:'b',prediction:[120,0]},{id:'3',name:'c',prediction:[0,120]}],[120,0]);
 assert.deepEqual(rows.map(p=>[p.rank,p.score]),[[1,120],[1,120],[3,0]]);
});
test('HTTP boundary: cookies, CSRF, methods, private data and persisted state',async()=>{
 const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 try{
 const state=await fetch(url+'/api/state?group=default');assert.equal(state.status,200);assert.equal(state.headers.get('cache-control'),'no-store');assert.equal((await state.json()).published,true);
 const routed=await fetch(url+'/api/index?ballotRoute=state&group=default');assert.equal(routed.status,200);assert.equal((await routed.json()).published,true);
 const denied=await fetch(url+'/api/admin/login?group=default',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://evil.example'},body:JSON.stringify({password:'x'})});assert.equal(denied.status,403);
 const login=await fetch(url+'/api/admin/login?group=default',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({password:'a test password of 24 chars'})});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/SameSite=Strict/);assert.equal((await login.json()).token,undefined);
 assert.equal((await (await fetch(url+'/api/state?group=default',{headers:{Cookie:cookie.split(';')[0]}})).json()).isAdmin,true);
 const invalid=await fetch(url+'/api/join?group=default',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:'bad'});assert.equal(invalid.status,400);
 const unsupported=await fetch(url+'/api/state?group=default',{method:'DELETE'});assert.equal(unsupported.status,405);
 const html=await fetch(url+'/admin');assert.equal(html.status,200);assert.match(html.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.match(await html.text(),/app.js/);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
test('deadline is enforced using server time even without a scheduler',async()=>{
 await db.query('UPDATE ballot_election SET published=false');await db.query('DELETE FROM ballot_players');await db.query("UPDATE ballot_game SET configured=true,published=false,locked=false,actual=NULL,parties='[\"א\",\"ב\"]',deadline=$1,version=version+1 WHERE id=1",[new Date(now+1000).toISOString()]);
 const p=await svc.join({name:'אחרון'},'deadline');const s=await svc.read();await svc.predict({version:s.version,prediction:[70,50]},{player:p.token});
 now+=1001;assert.equal((await svc.read()).closed,true);
 await rejected(()=>svc.predict({version:s.version,prediction:[60,60]},{player:p.token}),409);
 await rejected(()=>svc.join({name:'מאוחר'},'late'),409);
 const a={admin:(await svc.login({password:'a test password of 24 chars'},'deadlineadmin')).token};await rejected(()=>svc.lock({version:s.version,locked:false},a),409);
});
test('failed admin attempts persist and are rate limited',async()=>{
 for(let i=0;i<10;i++)await rejected(()=>svc.login({password:'wrong'},'brute'),401);
 await rejected(()=>svc.login({password:'a test password of 24 chars'},'brute'),429);
 now+=600001;assert.ok((await svc.login({password:'a test password of 24 chars'},'brute')).token);
});
test('concurrent lock and prediction cannot admit a write after locking',async()=>{
 await db.query('UPDATE ballot_game SET locked=false,deadline=$1,published=false WHERE id=1',[new Date(now+3600000).toISOString()]);
 const s=await svc.read(),p=await svc.join({name:'מרוץ'},'race'),a={admin:(await svc.login({password:'a test password of 24 chars'},'raceadmin')).token};
 const jobs=await Promise.allSettled([svc.lock({version:s.version,locked:true},a),svc.predict({version:s.version,prediction:[60,60]},{player:p.token})]);
 assert.equal(jobs[0].status,'fulfilled');assert.equal(jobs[1].status,'rejected');assert.equal(jobs[1].reason.status,409);
});

