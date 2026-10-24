import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {scryptSync} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {JSDOM,VirtualConsole,CookieJar} from 'jsdom';
import {getDb} from '../lib/db.mjs';
import {createServer} from '../server.mjs';
import {createService,digest} from '../lib/service.mjs';

test('v1 migration preserves existing group, participants, sessions and audit; reruns safely',async()=>{
 const db=new PGlite();
 try {
  const schema=await readFile(new URL('../lib/schema.sql',import.meta.url),'utf8');
  const legacy=schema.split('-- Additive v2 migration')[0];
  await db.exec(legacy);
  await db.query("UPDATE ballot_game SET title='הקבוצה המקורית',configured=true,parties=$1 WHERE id=1",[JSON.stringify(['א','ב'])]);
  await db.query("INSERT INTO ballot_players(id,name,name_key,token_hash,prediction) VALUES($1,'קיים','קיים','old-player',$2)",['00000000-0000-4000-8000-000000000001',JSON.stringify([70,50])]);
  await db.query("INSERT INTO ballot_admin_sessions VALUES('old-admin',now()+interval '1 hour')");
  await db.query("INSERT INTO ballot_audit(action) VALUES('old-audit')");
  await db.exec(schema);await db.exec(schema);
  assert.equal((await db.query('SELECT title,slug FROM ballot_game WHERE id=1')).rows[0].slug,'default');
  const player=(await db.query('SELECT * FROM ballot_players')).rows[0];
  assert.deepEqual(player.prediction,[70,50]);assert.equal(player.group_id,1);
  assert.equal((await db.query('SELECT group_id FROM ballot_admin_sessions')).rows[0].group_id,1);
  assert.equal((await db.query('SELECT group_id FROM ballot_audit')).rows[0].group_id,1);
  assert.equal((await db.query("INSERT INTO ballot_game(slug) VALUES('new') RETURNING id")).rows[0].id,2);
 } finally {await db.close();}
});

test('two groups: shared browser cookies, scoped admins, predictions, recovery, reports and UI links',async()=>{
 const dir=await mkdtemp(tmpdir()+'/ballot-groups-');
 process.env.LOCAL_DB_PATH=dir+'/db';
 const ownerPassword='site-owner-password-123',passA='group-A-password-123',passB='group-B-password-123';
 process.env.ADMIN_PASSWORD_HASH='scrypt$groups$'+scryptSync(ownerPassword,'groups',64).toString('hex');
 const db=await getDb(),server=createServer(),jar=new CookieJar(),clients=[];
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin='http://127.0.0.1:'+server.address().port;
 async function request(path,method='GET',body,slug,extraCookies=''){
  const url=origin+'/api/'+path+(slug===undefined?'':'?group='+encodeURIComponent(slug));
  const cookie=extraCookies||await jar.getCookieString(url);
  const r=await fetch(url,{method,headers:{Origin:origin,Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  for(const c of r.headers.getSetCookie())await jar.setCookie(c,url);
  return {status:r.status,data:await r.json()};
 }
 const ok=async(...args)=>{const r=await request(...args);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 const until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI did not arrive');};
 async function ui(path){
  const vc=new VirtualConsole();vc.on('jsdomError',e=>{throw e;});
  const d=await JSDOM.fromURL(origin+path,{cookieJar:jar,virtualConsole:vc,resources:'usable',runScripts:'dangerously',beforeParse(w){
   w.confirm=()=>true;w.fetch=async(path,options={})=>{
    const url=new URL(path,origin).href,cookie=await jar.getCookieString(url);
    const r=await fetch(url,{...options,headers:{...options.headers,Origin:origin,Cookie:cookie}});
    for(const c of r.headers.getSetCookie())await jar.setCookie(c,url);
    return r;
   };
  }});
  clients.push(d);await until(()=>d.window.document.querySelector('#ballot-status').textContent!=='מתחברים…');return d;
 }
 try {
  assert.equal((await request('admin/groups','POST',{title:'denied',password:passA})).status,401);
  await ok('admin/login','POST',{password:ownerPassword});
  const a=await ok('admin/groups','POST',{title:'קבוצה א',password:passA});
  const b=await ok('admin/groups','POST',{title:'קבוצה ב',password:passB});
  assert.notEqual(a.slug,b.slug);assert.equal(a.slug.length,24);
  const [ga,gb]=(await db.query('SELECT id,admin_password_hash FROM ballot_game WHERE id<>1 ORDER BY id')).rows;
  assert.ok(ga.admin_password_hash.startsWith('scrypt$'));assert.notEqual(ga.admin_password_hash,passA);
  assert.equal((await ok('state','GET',null,a.slug)).isAdmin,false);
  assert.equal((await request('admin/login','POST',{password:ownerPassword},a.slug)).status,401);
  assert.equal((await request('admin/login','POST',{password:passA},b.slug)).status,401);
  await ok('admin/login','POST',{password:passA},a.slug);
  await ok('admin/login','POST',{password:passB},b.slug);
  assert.equal((await request('admin/groups','POST',{title:'denied',password:passA},a.slug)).status,403);
  for(const [group,parties] of [[a,['א1','א2']],[b,['ב1','ב2']]]){
   const s=await ok('state','GET',null,group.slug);
   assert.equal(s.groups,undefined);
   await ok('admin/settings','PUT',{version:s.version,title:group.title,parties,deadline:new Date(Date.now()+86400000).toISOString()},group.slug);
  }
  const pa=await ok('join','POST',{name:'אותו שם'},a.slug),pb=await ok('join','POST',{name:'אותו שם'},b.slug);
  let sa=await ok('state','GET',null,a.slug),sb=await ok('state','GET',null,b.slug);
  assert.equal(sa.players.length,1);assert.equal(sb.players.length,1);assert.notEqual(sa.me.id,sb.me.id);
  await ok('prediction','PUT',{version:sa.version,prediction:[70,50]},a.slug);
  await ok('prediction','PUT',{version:sb.version,prediction:[20,100]},b.slug);
  assert.equal((await request('recover','POST',{token:pa.token},b.slug)).status,401);
  const serviceB=createService(db,{groupId:gb.id}),serviceA=createService(db,{groupId:ga.id});
  assert.equal((await serviceB.read({player:pa.token})).me,null);
  await assert.rejects(()=>serviceB.personalLink({player:pa.token}),e=>e.status===401);
  await assert.rejects(()=>serviceB.predict({version:sb.version,prediction:[60,60]},{player:pa.token}),e=>e.status===401);
  const aSession=(await db.query('SELECT token_hash FROM ballot_admin_sessions WHERE group_id=$1',[ga.id])).rows[0];
  assert.ok(aSession);
  // Read actual A token from its group-specific browser cookie; presenting it to B must fail.
  const aCookie=(await jar.getCookies(origin)).find(c=>c.key==='ballot-g'+ga.id+'-admin');
  await assert.rejects(()=>serviceB.lock({version:sb.version,locked:true},{admin:aCookie.value}),e=>e.status===401);
  assert.equal((await serviceB.read({admin:aCookie.value})).isAdmin,false);
  await ok('admin/lock','PUT',{version:sa.version,locked:true},a.slug);
  sa=await ok('state','GET',null,a.slug);
  await ok('admin/results','PUT',{version:sa.version,actual:[70,50],note:'רק א'},a.slug);
  sa=await ok('state','GET',null,a.slug);sb=await ok('state','GET',null,b.slug);
  assert.equal(sa.scoreboard.length,1);assert.equal(sa.scoreboard[0].score,120);
  assert.equal(sb.published,false);assert.equal(sb.closed,false);assert.equal(sb.actual,null);assert.deepEqual(sb.scoreboard,[]);
  assert.deepEqual(sb.me.prediction,[20,100]);
  await ok('prediction','PUT',{version:sb.version,prediction:[30,90]},b.slug);
  const publicB=await serviceB.read();assert.equal(publicB.players[0].prediction,undefined);assert.equal(publicB.groups,undefined);
  assert.equal((await ok('state')).groups.length,2);
  // Unknown groups must never fall back to the original group.
  for(const slug of ['','missing','x'.repeat(24),'default&group=other']){
   assert.equal((await request('state','GET',null,slug)).status,404);
  }
  const routed=await ok('index?ballotRoute=state&group='+b.slug);
  assert.equal(routed.groupSlug,b.slug);assert.equal(routed.title,'קבוצה ב');
  const duplicate=await fetch(origin+'/api/state?group='+a.slug+'&group='+b.slug);
  assert.equal(duplicate.status,404);
  // UI navigation, share/recovery URLs and direct scoreboard all retain group scope.
  const d=await ui('/?group='+b.slug),doc=d.window.document;
  assert.match(doc.querySelector('h1').textContent,/אותו שם/);
  doc.querySelector('#show-personal-link').click();
  await until(()=>doc.querySelector('#recovery-url'));
  const link=doc.querySelector('#recovery-url').value;
  assert.equal(new URL(link).searchParams.get('group'),b.slug);assert.match(link,/#access=/);
  doc.querySelector('[data-tab="admin"]').click();
  assert.equal(new URL(d.window.location.href).searchParams.get('group'),b.slug);
  assert.equal(doc.querySelector('#create-group-form'),null);
  assert.equal(doc.querySelector('[aria-label="קישור הקבוצה"]').value,origin+'/?group='+b.slug);
  const report=await ui('/?group='+a.slug+'#ranking');
  assert.ok(report.window.document.querySelector('#download-report'));
  assert.match(report.window.document.body.textContent,/קבוצה א/);
  assert.equal(new URL(report.window.location.href).searchParams.get('group'),a.slug);
  const recovered=await ui('/?group='+b.slug+new URL(link).hash);
  await until(()=>recovered.window.document.querySelector('#submit'));
  assert.equal(recovered.window.location.hash,'');
  assert.equal(recovered.window.document.querySelector('[data-seat="0"]').value,'30');
  const owner=await ui('/admin');
  assert.ok(owner.window.document.querySelector('#create-group-form'));
  assert.equal(owner.window.document.querySelectorAll('a[href^="/admin?group="]').length,2);
  const ownerDoc=owner.window.document;
  ownerDoc.querySelector('#new-group-title').value='קבוצה מהממשק';
  ownerDoc.querySelector('#new-group-password').value='group-C-password-123';
  ownerDoc.querySelector('#create-group-form').dispatchEvent(new owner.window.Event('submit',{bubbles:true,cancelable:true}));
  await until(()=>ownerDoc.querySelectorAll('a[href^="/admin?group="]').length===3);
  assert.equal(ownerDoc.querySelector('#new-group-password').value,'');
  // Logging out of A leaves B and the original site owner logged in.
  await ok('admin/logout','POST',{},a.slug);
  assert.equal((await ok('state','GET',null,a.slug)).isAdmin,false);
  assert.equal((await ok('state','GET',null,b.slug)).isAdmin,true);
  assert.equal((await ok('state')).isAdmin,true);
  assert.ok((await db.query('SELECT group_id FROM ballot_audit WHERE action=$1',['publish_results'])).rows.every(x=>x.group_id===ga.id));
 } finally {
  for(const d of clients)d.window.close();
  await new Promise(r=>server.close(r));await db.close();await rm(dir,{recursive:true,force:true});
 }
});
