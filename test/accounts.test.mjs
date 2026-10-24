import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {CookieJar,JSDOM,VirtualConsole} from 'jsdom';
import {getDb} from '../lib/db.mjs';
import {createServer} from '../server.mjs';
import {createAccounts,accountUser} from '../lib/accounts.mjs';
import {createService,digest} from '../lib/service.mjs';

test('public organizer accounts own groups; invited guests never gain administration',async()=>{
 const dir=await mkdtemp(tmpdir()+'/ballot-accounts-');process.env.LOCAL_DB_PATH=dir+'/db';
 const db=await getDb(),server=createServer(),a=new CookieJar(),b=new CookieJar(),guest=new CookieJar(),clients=[];
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 async function call(jar,path,method='GET',body,headers={}){
  const url=origin+'/api/'+path;
  const r=await fetch(url,{method,headers:{Origin:origin,Cookie:await jar.getCookieString(url),...headers,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  for(const c of r.headers.getSetCookie())await jar.setCookie(c,url);
  return {status:r.status,data:await r.json(),headers:r.headers};
 }
 const ok=async(...args)=>{const r=await call(...args);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;};
 const until=async fn=>{const end=Date.now()+10000;while(Date.now()<end){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw Error('UI did not arrive');};
 async function ui(jar,path='/'){
  const vc=new VirtualConsole(),errors=[];vc.on('jsdomError',e=>errors.push(e.message));
  const d=await JSDOM.fromURL(origin+path,{resources:'usable',runScripts:'dangerously',cookieJar:jar,virtualConsole:vc,beforeParse(w){
   w.confirm=()=>true;w.fetch=async(path,opt={})=>{
    const url=new URL(path,origin).href;
    const r=await fetch(url,{...opt,headers:{...opt.headers,Origin:origin,Cookie:await jar.getCookieString(url)}});
    for(const c of r.headers.getSetCookie())await jar.setCookie(c,url);
    return r;
   };
  }});clients.push(d);await until(()=>d.window.document.querySelector('#ballot-status').textContent!=='מתחברים…');assert.deepEqual(errors,[]);return d;
 }
 const submit=(d,id)=>d.window.document.querySelector(id).dispatchEvent(new d.window.Event('submit',{bubbles:true,cancelable:true}));
 const field=(d,id,v)=>{d.window.document.querySelector(id).value=v;};
 try{
  assert.deepEqual(await ok(guest,'account/state'),{user:null,groups:[]});
  assert.equal((await call(guest,'account/groups','POST',{title:'no'})).status,401);
  const password='organizer-password-123';
  const csrf=await call(a,'account/register','POST',{username:'Alpha',password},{Origin:'https://evil.example'});
  assert.equal(csrf.status,403);
  const registered=await call(a,'account/register','POST',{username:'Alpha',password});
  assert.equal(registered.status,200);assert.deepEqual(registered.data,{ok:true});
  assert.match(registered.headers.get('set-cookie'),/HttpOnly/);assert.match(registered.headers.get('set-cookie'),/SameSite=Strict/);
  await ok(b,'account/register','POST',{username:'Beta',password});
  assert.equal((await call(guest,'account/register','POST',{username:'alpha',password})).status,409);
  assert.equal((await call(guest,'account/register','POST',{username:'bad name',password})).status,400);
  assert.equal((await call(guest,'account/register','POST',{username:'short',password:'short'})).status,400);
  assert.equal((await call(guest,'account/login','POST',{username:'missing',password})).status,401);
  assert.equal((await call(guest,'account/login','POST',{username:'Alpha',password:'wrong'})).status,401);
  const ua=(await ok(a,'account/state')).user,ub=(await ok(b,'account/state')).user;
  assert.equal(ua.username,'Alpha');assert.equal(ua.password_hash,undefined);
  const group=await ok(a,'account/groups','POST',{title:'של אלפא',owner_id:ub.id});
  const other=await ok(b,'account/groups','POST',{title:'של בטא'});
  const record=(await db.query('SELECT id,owner_id,admin_password_hash FROM ballot_game WHERE slug=$1',[group.slug])).rows[0];
  assert.equal(record.owner_id,ua.id);assert.equal(record.admin_password_hash,null);
  assert.deepEqual((await ok(b,'account/state')).groups.map(g=>g.slug),[other.slug]);
  assert.deepEqual((await ok(a,'account/state')).groups.map(g=>g.slug),[group.slug]);
  const scope='?group='+group.slug;
  let state=await ok(a,'state'+scope);assert.equal(state.isAdmin,true);assert.equal(state.accountManaged,true);
  assert.equal((await ok(b,'state'+scope)).isAdmin,false);
  assert.equal((await ok(guest,'state'+scope)).isAdmin,false);
  const settings={version:state.version,title:'של אלפא',parties:['א','ב'],deadline:new Date(Date.now()+86400000).toISOString()};
  for(const jar of [b,guest])assert.equal((await call(jar,'admin/settings'+scope,'PUT',settings)).status,401);
  await ok(a,'admin/settings'+scope,'PUT',settings);
  const participant=await ok(guest,'join'+scope,'POST',{name:'חבר חופשי'});
  state=await ok(guest,'state'+scope);
  await ok(guest,'prediction'+scope,'PUT',{version:state.version,prediction:[80,40],owner_id:ua.id});
  for(const action of ['lock','results']){
   assert.equal((await call(guest,'admin/'+action+scope,'PUT',{version:state.version,locked:true,actual:[80,40]})).status,401);
   assert.equal((await call(b,'admin/'+action+scope,'PUT',{version:state.version,locked:true,actual:[80,40]})).status,401);
  }
  const publicState=await ok(guest,'state'+scope);
  assert.equal(publicState.owner_id,undefined);assert.equal(publicState.admin_password_hash,undefined);assert.equal(publicState.groups,undefined);
  assert.equal((await db.query('SELECT token_hash FROM ballot_players WHERE id=$1',[participant.id])).rows[0].token_hash,digest(participant.token));
  const userRecord=(await db.query('SELECT password_hash FROM ballot_users WHERE id=$1',[ua.id])).rows[0];
  assert.ok(userRecord.password_hash.startsWith('scrypt$'));assert.notEqual(userRecord.password_hash,password);
  const oldToken=(await a.getCookies(origin)).find(c=>c.key==='ballot-account').value;
  await ok(a,'account/logout','POST',{});
  assert.equal(await accountUser(db,oldToken),null);
  assert.equal((await ok(a,'state'+scope)).isAdmin,false);
  await ok(a,'account/login','POST',{username:'ALPHA',password});
  assert.equal((await ok(a,'state'+scope)).isAdmin,true);
  const currentToken=(await a.getCookies(origin)).find(c=>c.key==='ballot-account').value;
  assert.equal(await accountUser(db,currentToken,Date.now()+9*3600000),null);
  assert.equal((await createService(db,{groupId:record.id,clock:()=>Date.now()+9*3600000}).read({account:currentToken})).isAdmin,false);
  // A guest UI has the prediction form and a locked admin page, with no signup requirement.
  const g=await ui(guest,'/'+scope);assert.ok(g.window.document.querySelector('#submit'));assert.equal(g.window.document.querySelector('#account-auth-form'),null);
  const blocked=await ui(guest,'/admin'+scope);assert.equal(blocked.window.document.querySelector('#settings-form'),null);
  assert.match(blocked.window.document.body.textContent,/כניסה לחשבון המנהל/);
  // Full browser flow: signup -> create group -> owner admin -> logout -> signin.
  const c=new CookieJar(),d=await ui(c),doc=d.window.document;
  doc.querySelector('[data-account-mode="register"]').click();
  field(d,'#account-username','Gamma');field(d,'#account-password',password);submit(d,'#account-auth-form');
  await until(()=>doc.querySelector('#account-group-form'));
  field(d,'#account-group-title','קבוצה דרך המסך');submit(d,'#account-group-form');
  await until(()=>doc.querySelector('a[href^="/admin?group="]'));
  const adminPath=doc.querySelector('a[href^="/admin?group="]').getAttribute('href');
  const invitation=doc.querySelector('input.recovery').value;
  assert.ok(new URL(invitation).searchParams.get('group'));
  const admin=await ui(c,adminPath);
  assert.ok(admin.window.document.querySelector('#settings-form'));
  assert.equal(admin.window.document.querySelector('#login-form'),null);
  admin.window.document.querySelector('#logout').click();
  await until(()=>!admin.window.document.querySelector('#settings-form'));
  assert.equal((await ok(c,'account/state')).user,null);
  const returning=await ui(c);
  field(returning,'#account-username','Gamma');field(returning,'#account-password',password);submit(returning,'#account-auth-form');
  await until(()=>returning.window.document.querySelector('#account-group-form'));
  assert.equal(returning.window.document.querySelector('a[href^="/admin?group="]').getAttribute('href'),adminPath);
  // Persistent failed-login counters still block attempts after correct credentials.
  const accounts=createAccounts(db);
  for(let i=0;i<10;i++)await assert.rejects(()=>accounts.login({username:'limited',password:'wrong'},'limit-test'),e=>e.status===401);
  await assert.rejects(()=>accounts.login({username:'limited',password},'limit-test'),e=>e.status===429);
 }finally{
  for(const d of clients)d.window.close();
  await new Promise(r=>server.close(r));await db.close();await rm(dir,{recursive:true,force:true});
 }
});
