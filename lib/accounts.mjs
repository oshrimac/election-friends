import {randomBytes,randomUUID,scrypt,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {AppError,digest} from './service.mjs';
const derive=promisify(scrypt),fail=(status,msg)=>{throw new AppError(status,msg);};
const token=()=>randomBytes(32).toString('base64url');
const usernameKey=value=>typeof value==='string'?value.normalize('NFKC').trim().toLocaleLowerCase('he'):'';
export async function accountUser(db,value,now=Date.now()){
 if(typeof value!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(value))return null;
 return (await db.query('SELECT u.id,u.username FROM ballot_user_sessions s JOIN ballot_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',[digest(value),new Date(now).toISOString()])).rows[0]||null;
}
export function createAccounts(db,{clock=()=>Date.now()}={}){
 async function limit(action,key,max){
  const r=await db.query('INSERT INTO ballot_rate_limits(key,count,expires_at) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=ballot_rate_limits.count+1 RETURNING count',
   [digest('account:'+action+':'+key+':'+Math.floor(clock()/600000)),new Date(clock()+1200000).toISOString()]);
  if(r.rows[0].count>max)fail(429,'יותר מדי ניסיונות. נסו שוב בעוד עשר דקות');
 }
 async function user(auth){const u=await accountUser(db,auth,clock());if(!u)fail(401,'צריך להיכנס לחשבון כדי לנהל קבוצות');return u;}
 async function session(tx,id){
  const t=token();
  await tx.query('DELETE FROM ballot_user_sessions WHERE expires_at<=$1',[new Date(clock()).toISOString()]);
  await tx.query('DELETE FROM ballot_rate_limits WHERE expires_at<=$1',[new Date(clock()).toISOString()]);
  await tx.query('INSERT INTO ballot_user_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[digest(t),id,new Date(clock()+8*3600000).toISOString()]);
  return {token:t};
 }
 return {
 async state(auth){
  const u=await accountUser(db,auth,clock());
  return {user:u,groups:u?(await db.query('SELECT slug,title,configured FROM ballot_game WHERE owner_id=$1 ORDER BY id',[u.id])).rows:[]};
 },
 async register(body,ip){
  await limit('register',ip,10);
  const key=usernameKey(body.username);
  if(!/^[\p{L}\p{N}_.-]{3,40}$/u.test(key))fail(400,'שם משתמש: 3–40 אותיות, ספרות, נקודה, מקף או קו תחתון');
  if(typeof body.password!=='string'||body.password.length<16||body.password.length>256)fail(400,'בחרו סיסמה של 16–256 תווים');
  const salt=randomBytes(16).toString('hex'),hash='scrypt$'+salt+'$'+(await derive(body.password,salt,64)).toString('hex');
  try{return await db.transaction(async tx=>{
   const id=randomUUID();
   await tx.query('INSERT INTO ballot_users(id,username,username_key,password_hash) VALUES($1,$2,$3,$4)',[id,body.username.normalize('NFKC').trim(),key,hash]);
   return session(tx,id);
  });}catch(e){if(e.code==='23505')fail(409,'שם המשתמש כבר תפוס');throw e;}
 },
 async login(body,ip){
  await limit('login-ip',ip,20);
  const key=usernameKey(body.username);
  await limit('login-name',key,10);
  if(typeof body.password!=='string'||body.password.length>256||key.length>40)fail(401,'שם המשתמש או הסיסמה לא נכונים');
  const u=(await db.query('SELECT id,password_hash FROM ballot_users WHERE username_key=$1',[key])).rows[0];
  const parts=u?.password_hash.split('$');
  const actual=await derive(body.password,parts?.[1]||'unknown-account-password-check',64);
  if(!u||!timingSafeEqual(actual,Buffer.from(parts[2],'hex')))fail(401,'שם המשתמש או הסיסמה לא נכונים');
  return db.transaction(tx=>session(tx,u.id));
 },
 async logout(auth){
  if(auth)await db.query('DELETE FROM ballot_user_sessions WHERE token_hash=$1',[digest(auth)]);
  return {ok:true};
 },
 async createGroup(body,auth,ip){
  const u=await user(auth);
  await limit('groups',u.id,10);
  const title=typeof body.title==='string'?body.title.trim():'';
  if(!title||title.length>80)fail(400,'יש להזין שם קבוצה עד 80 תווים');
  return db.transaction(async tx=>{
   // Recheck the session inside the write transaction; never trust a client owner ID.
   const current=await accountUser(tx,auth,clock());
   if(!current)fail(401,'הכניסה פגה. היכנסו שוב');
   const slug=randomBytes(18).toString('base64url');
   const g=(await tx.query('INSERT INTO ballot_game(slug,title,owner_id) VALUES($1,$2,$3) RETURNING id',[slug,title,current.id])).rows[0];
   await tx.query("INSERT INTO ballot_audit(action,group_id,detail) VALUES('create_group',$1,$2)",[g.id,JSON.stringify({title})]);
   return {slug,title};
  });
 }
 };
}
