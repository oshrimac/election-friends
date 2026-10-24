import { getDb } from '../lib/db.mjs';
import { createService, AppError } from '../lib/service.mjs';
const cookieName=process.env.VERCEL||process.env.NODE_ENV==='production'?'__Host-ballot':'ballot';
function cookies(req) {const result={};for(const part of (req.headers.cookie||'').split(';')) {const at=part.indexOf('=');if(at>0) result[part.slice(0,at).trim()]=part.slice(at+1).trim();}return result;}
function setCookie(res,name,value,age) {res.setHeader('Set-Cookie',`${cookieName}-${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${cookieName.startsWith('__Host-')?'; Secure':''}`);}
export default async function handler(req,res) {
 res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');
 const send=(code,data)=>{res.statusCode=code;res.end(JSON.stringify(data));};
 try {
  const requestUrl=new URL(req.url,'http://localhost');
  const path=requestUrl.pathname==='/api/index'&&requestUrl.searchParams.has('ballotRoute')?'/api/'+requestUrl.searchParams.get('ballotRoute'):requestUrl.pathname;
  if(req.method!=='GET'&&req.method!=='POST'&&req.method!=='PUT') {res.setHeader('Allow','GET, POST, PUT');throw new AppError(405,'שיטה לא נתמכת');}
  if(req.method!=='GET') {
   if(!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415,'נדרש JSON');
   const origin=req.headers.origin;
   const host=process.env.APP_URL?new URL(process.env.APP_URL).host:req.headers.host;
   const expectedProtocol=process.env.APP_URL?new URL(process.env.APP_URL).protocol:(process.env.VERCEL||process.env.NODE_ENV==='production'?'https:':'http:');
   if(!origin||new URL(origin).host!==host||new URL(origin).protocol!==expectedProtocol||req.headers['sec-fetch-site']==='cross-site') throw new AppError(403,'הבקשה חייבת להגיע מתוך האתר');
  }
  let body={};
  if(req.method!=='GET') {
   if(req.body!==undefined) {body=typeof req.body==='string'?JSON.parse(req.body):req.body;if(JSON.stringify(body).length>16384) throw new AppError(413,'בקשה גדולה מדי');}
   else {let data='';for await (const chunk of req) {data+=chunk;if(Buffer.byteLength(data)>16384) throw new AppError(413,'בקשה גדולה מדי');}try {body=JSON.parse(data);} catch {throw new AppError(400,'JSON אינו תקין');}}
   if(!body||typeof body!=='object'||Array.isArray(body)) throw new AppError(400,'בקשה לא תקינה');
  }
  const c=cookies(req),auth={player:c[cookieName+'-player'],admin:c[cookieName+'-admin']};
  const svc=createService(await getDb());
  const ip=process.env.VERCEL?(req.headers['x-real-ip']||'unknown'):req.socket?.remoteAddress||'local';
  let result;
  if(path==='/api/state'&&req.method==='GET') result=await svc.read(auth);
  else if(path==='/api/join'&&req.method==='POST') {result=await svc.join(body,ip);setCookie(res,'player',result.token,31536000);}
  else if(path==='/api/recover'&&req.method==='POST') {result=await svc.recover(body,ip);setCookie(res,'player',result.token,31536000);result={ok:true};}
  else if(path==='/api/personal-link'&&req.method==='POST') result=await svc.personalLink(auth);
  else if(path==='/api/prediction'&&req.method==='PUT') result=await svc.predict(body,auth);
  else if(path==='/api/admin/login'&&req.method==='POST') {result=await svc.login(body,ip);setCookie(res,'admin',result.token,28800);result={ok:true};}
  else if(path==='/api/admin/logout'&&req.method==='POST') {result=await svc.logout(auth);setCookie(res,'admin','',0);}
  else if(path==='/api/admin/settings'&&req.method==='PUT') result=await svc.configure(body,auth);
  else if(path==='/api/admin/lock'&&req.method==='PUT') result=await svc.lock(body,auth);
  else if(path==='/api/admin/results'&&req.method==='PUT') result=await svc.results(body,auth);
  else throw new AppError(404,'הפעולה לא נמצאה');
  send(200,result);
 } catch(e) {
  if(e instanceof AppError) send(e.status,{error:e.message});
  else if(e instanceof SyntaxError) send(400,{error:'בקשה אינה תקינה'});
  else {console.error('ballot_api_error',e.code||e.name);send(503,{error:'השרת או מסד הנתונים אינם זמינים. נסו שוב; מנהל האתר יכול לבדוק את ההגדרות והיומנים.'});}
 }
}
