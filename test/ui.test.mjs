import {test} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM,VirtualConsole,CookieJar} from 'jsdom';
import {scryptSync} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from '../server.mjs';
import {getDb} from '../lib/db.mjs';
const until=async(fn)=>{const limit=Date.now()+10000;while(Date.now()<limit){if(fn())return;await new Promise(r=>setTimeout(r,20));}throw new Error('UI state did not arrive');};
test('independent DOM clients: configure → join → save → recover → lock → publish → shared report',async()=>{
 const dir=await mkdtemp(tmpdir()+'/ballot-ui-');process.env.LOCAL_DB_PATH=dir+'/db';
 const password='test-only-password-123456';process.env.ADMIN_PASSWORD_HASH='scrypt$ui$'+scryptSync(password,'ui',64).toString('hex');
 const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port,clients=[],errors=[];
 async function client(path='/') {
  const jar=new CookieJar(),vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e.message));
  const dom=await JSDOM.fromURL(origin+path,{resources:'usable',runScripts:'dangerously',pretendToBeVisual:true,cookieJar:jar,virtualConsole:vc,beforeParse(w){
   w.confirm=()=>true;w.fetch=async(path,options={})=>{const url=new URL(path,origin).href,cookie=await jar.getCookieString(url);const r=await fetch(url,{...options,headers:{...options.headers,Origin:origin,...(cookie?{Cookie:cookie}:{})}});for(const c of r.headers.getSetCookie())await jar.setCookie(c,url);return r;};
  }});clients.push(dom);await until(()=>dom.window.document.querySelector('#ballot-status')?.textContent!=='מתחברים…');return dom;
 }
 function field(d,id,value){const el=d.window.document.querySelector(id);assert.ok(el,id);el.value=value;el.dispatchEvent(new d.window.Event('input',{bubbles:true}));}
 function submit(d,id){d.window.document.querySelector(id).dispatchEvent(new d.window.Event('submit',{bubbles:true,cancelable:true}));}
 function click(d,id){d.window.document.querySelector(id).click();}
 async function login(d){field(d,'#admin-password',password);submit(d,'#login-form');await until(()=>d.window.document.querySelector('#settings-form'));}
 try {
 const a=await client('/admin');await login(a);field(a,'#group-title','החברים מהבדיקה');field(a,'#party-names','רשימה א\nרשימה ב\nרשימה ג');field(a,'#close-time',new Date(Date.now()+86400000).toISOString().slice(0,16));submit(a,'#settings-form');await until(()=>a.window.document.querySelector('#publish'));
 const p=await client();field(p,'#player-name','נועה');submit(p,'#join-form');await until(()=>p.window.document.querySelector('#submit'));
 const recovery=p.window.document.querySelector('#recovery-url').value;assert.match(recovery,/#access=/);
 for(const [i,v] of [60,50,10].entries())field(p,`[data-seat="${i}"]`,String(v));
 assert.equal(p.window.document.querySelector('#seat-total').textContent,'120');assert.equal(p.window.document.querySelector('#submit').disabled,false);click(p,'#submit');await until(()=>p.window.document.querySelector('#save-status')?.textContent.includes('יש קבלות מ־'));
 const p2=await client();field(p2,'#player-name','איתי');submit(p2,'#join-form');await until(()=>p2.window.document.querySelector('#submit'));
 for(const [i,v] of [58,52,10].entries())field(p2,`[data-seat="${i}"]`,String(v));click(p2,'#submit');await until(()=>p2.window.document.querySelector('#save-status')?.textContent.includes('יש קבלות מ־'));
 const spectator=await client('/#ranking');assert.equal(spectator.window.document.querySelector('details'),null);assert.match(spectator.window.document.body.textContent,/נועה/);
 const recovered=await client('/'+new URL(recovery).hash);await until(()=>recovered.window.document.querySelector('#submit'));assert.match(recovered.window.document.querySelector('h1').textContent,/נועה/);assert.equal(recovered.window.location.hash,'');assert.equal(recovered.window.document.querySelector('[data-seat="0"]').value,'60');
 click(a,'#lock');await until(()=>a.window.document.querySelector('#lock')?.textContent==='פתיחה מחדש');
 for(const [i,v] of [60,50,10].entries())field(a,`[data-seat="${i}"]`,String(v));field(a,'#results-note','תוצאות בדיקת ממשק');click(a,'#publish');await until(()=>a.window.document.querySelector('#download-report'));
 assert.match(a.window.document.body.textContent,/120/);assert.match(a.window.document.body.textContent,/118/);
 const report=await client('/#ranking');const body=report.window.document.body.textContent;assert.match(body,/יש קבלות/);assert.match(body,/נועה/);assert.match(body,/איתי/);assert.equal(report.window.document.querySelectorAll('details').length,2);assert.equal(report.window.document.querySelector('#publish'),null);
 const locked=await client('/'+new URL(recovery).hash);await until(()=>locked.window.document.querySelector('#submit'));assert.equal(locked.window.document.querySelector('#submit').disabled,true);assert.equal(locked.window.document.querySelector('[data-seat]'),null);
 assert.deepEqual(errors,[]);
 } finally {for(const c of clients)c.window.close();await new Promise(r=>server.close(r));await (await getDb()).close();await rm(dir,{recursive:true,force:true});}
});

