import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
export class AppError extends Error { constructor(status, message) { super(message); this.status=status; } }
export const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const fail = (status, msg) => { throw new AppError(status,msg); };
export function vector(v, n) { return Array.isArray(v) && v.length===n && v.every(x=>Number.isInteger(x)&&x>=0&&x<=120) && v.reduce((a,b)=>a+b,0)===120; }
export function scoreboard(players, actual) {
 const sorted=players.filter(p=>p.prediction).map(p=>({id:p.id,name:p.name,prediction:p.prediction,score:120-p.prediction.reduce((s,x,i)=>s+Math.abs(x-actual[i]),0)/2})).sort((a,b)=>b.score-a.score || a.name.localeCompare(b.name,'he') || a.id.localeCompare(b.id));
 let last, rank;
 return sorted.map((p,i)=>{if(p.score!==last) rank=i+1;last=p.score;return {...p,rank};});
}
export function passwordMatches(value, encoded) {
 if (typeof value!=='string'||value.length>256||!encoded) return false;
 const [kind,salt,expected]=encoded.split('$');
 if(kind!=='scrypt'||!salt||!expected||!/^[0-9a-f]{128}$/.test(expected)) return false;
 return timingSafeEqual(scryptSync(value,salt,64),Buffer.from(expected,'hex'));
}
export function createService(db, options={}) {
 const groupId=options.groupId??1;
 if(!Number.isSafeInteger(groupId)||groupId<1) fail(404,'הקבוצה לא נמצאה');
 const clock=options.clock||(()=>Date.now());
 const closed=g=>!g.configured||g.locked||g.published||!g.deadline||Date.parse(g.deadline)<=clock();
 const game=async tx=>{
  const g=(await tx.query('SELECT * FROM ballot_game WHERE id=$1 FOR UPDATE',[groupId])).rows[0];
  if(!g) fail(404,'הקבוצה לא נמצאה');
  return g;
 };
 async function admin(tx, auth) {
  if(auth.account){
   const owner=(await tx.query('SELECT g.id FROM ballot_game g JOIN ballot_user_sessions s ON s.user_id=g.owner_id WHERE g.id=$1 AND s.token_hash=$2 AND s.expires_at>$3',[groupId,digest(auth.account),new Date(clock()).toISOString()])).rows[0];
   if(owner)return;
  }
  if(!auth.admin) fail(401,'נדרשת כניסת מנהל');
  const r=await tx.query('SELECT token_hash FROM ballot_admin_sessions WHERE token_hash=$1 AND expires_at>$2 AND group_id=$3',[digest(auth.admin),new Date(clock()).toISOString(),groupId]);
  if(!r.rows.length) fail(401,'כניסת המנהל פגה. יש להיכנס שוב');
 }
 async function rate(tx, action, ip, limit) {
  const key=digest(groupId+':'+action+':'+ip+':'+Math.floor(clock()/600000));
  const r=await tx.query('INSERT INTO ballot_rate_limits(key,count,expires_at) VALUES($1,1,$2) ON CONFLICT(key) DO UPDATE SET count=ballot_rate_limits.count+1 RETURNING count',[key,new Date(clock()+1200000).toISOString()]);
  return r.rows[0].count<=limit;
 }
 // Commit failed attempts too: an exception inside the authentication transaction would roll them back.
 async function limit(action, ip, n) { if(!await db.transaction(tx=>rate(tx,action,ip,n))) fail(429,'יותר מדי ניסיונות. נסו שוב בעוד עשר דקות'); }
 async function audit(tx, action, detail={}) {await tx.query('INSERT INTO ballot_audit(action,detail,group_id) VALUES($1,$2,$3)',[action,JSON.stringify(detail),groupId]);}
 return {
 async createGroup(body,auth,ip) {
  if(groupId!==1) fail(403,'יצירת קבוצות זמינה רק למנהל האתר');
  await limit('create-group',ip,10);
  const title=typeof body.title==='string'?body.title.trim():'';
  if(!title||title.length>80) fail(400,'יש להזין שם קבוצה עד 80 תווים');
  if(typeof body.password!=='string'||body.password.length<16||body.password.length>256) fail(400,'בחרו סיסמת ניהול של 16–256 תווים');
  // Verify authority before doing expensive password hashing.
  await db.transaction(tx=>admin(tx,auth));
  const salt=randomBytes(16).toString('hex');
  const passwordHash='scrypt$'+salt+'$'+scryptSync(body.password,salt,64).toString('hex');
  return db.transaction(async tx=>{
   await admin(tx,auth);
   const slug=randomBytes(18).toString('base64url');
   await tx.query('INSERT INTO ballot_game(slug,title,admin_password_hash) VALUES($1,$2,$3)',[slug,title,passwordHash]);
   await audit(tx,'create_group',{slug,title});
   return {slug,title};
  });
 },
 async read(auth={}) {return db.transaction(async tx=>{
  const g=await game(tx);let isAdmin=false;
  if(auth.admin||auth.account) { try {await admin(tx,auth);isAdmin=true;} catch(e) {if(!(e instanceof AppError)) throw e;} }
  const ps=(await tx.query('SELECT id,name,prediction,submitted_at FROM ballot_players WHERE group_id=$1 ORDER BY created_at,id',[groupId])).rows;
  const me=auth.player?(await tx.query('SELECT id,name,prediction,submitted_at FROM ballot_players WHERE token_hash=$1 AND group_id=$2',[digest(auth.player),groupId])).rows[0]:null;
  return {accountManaged:!!g.owner_id,groupSlug:g.slug,title:g.title,parties:g.parties,deadline:g.deadline,configured:g.configured,closed:closed(g),manualLocked:g.locked,published:g.published,version:g.version,
   actual:g.published?g.actual:null,resultsNote:g.published?g.results_note:'',publishedAt:g.published_at,
   players:ps.map(p=>({id:p.id,name:p.name,submitted:!!p.prediction,...(closed(g)&&p.prediction?{prediction:p.prediction}:{})})),
   me:me?{id:me.id,name:me.name,prediction:me.prediction,submittedAt:me.submitted_at}:null,
   scoreboard:g.published?scoreboard(ps,g.actual):[],isAdmin,
   ...(isAdmin?{adminActual:g.actual,adminResultsNote:g.results_note}:{}),
   ...(isAdmin&&groupId===1?{groups:(await tx.query('SELECT slug,title FROM ballot_game WHERE id<>1 ORDER BY id')).rows}:{}),serverTime:new Date(clock()).toISOString()};
 });},
 async join(body, ip) {
  await limit('join',ip,20);
  return db.transaction(async tx=>{
   const g=await game(tx);if(closed(g)) fail(409,'ההצטרפות והתחזיות סגורות');
   const name=typeof body.name==='string'?body.name.normalize('NFKC').trim().replace(/\s+/g,' '):'';
   if(!name||name.length>40||/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/.test(name)) fail(400,'יש להזין שם של 1–40 תווים');
   const nameKey=name.toLocaleLowerCase('he');
   if((await tx.query('SELECT id FROM ballot_players WHERE name_key=$1 AND group_id=$2',[nameKey,groupId])).rows.length) fail(409,'השם כבר תפוס. הוסיפו שם משפחה, או השתמשו בקישור האישי שלכם');
   const t=token(),id=randomUUID();
   await tx.query('INSERT INTO ballot_players(id,name,name_key,token_hash,group_id) VALUES($1,$2,$3,$4,$5)',[id,name,nameKey,digest(t),groupId]);
   return {token:t,id,name};
  });
 },
 async recover(body, ip) {
  await limit('recover',ip,30);
  if(typeof body.token!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(body.token)) fail(401,'הקישור האישי אינו תקין');
  const p=(await db.query('SELECT id FROM ballot_players WHERE token_hash=$1 AND group_id=$2',[digest(body.token),groupId])).rows[0];
  if(!p) fail(401,'הקישור האישי אינו תקין');return {token:body.token};
 },
 async personalLink(auth) {
  if(!auth.player || !(await db.query('SELECT id FROM ballot_players WHERE token_hash=$1 AND group_id=$2',[digest(auth.player),groupId])).rows.length) fail(401,'יש לפתוח את הקישור האישי או להצטרף תחילה');
  return {token:auth.player};
 },
 async predict(body, auth) {return db.transaction(async tx=>{
  const g=await game(tx);if(closed(g)) fail(409,'התחזיות נעולות. לא ניתן לשנות או להגיש');
  if(body.version!==g.version) fail(409,'הגדרות הקבוצה השתנו. רעננו לפני ההגשה');
  if(!vector(body.prediction,g.parties.length)) fail(400,'התחזית חייבת לכלול מנדטים שלמים בסכום 120');
  if(!auth.player) fail(401,'יש להצטרף או לפתוח את הקישור האישי');
  const r=await tx.query('UPDATE ballot_players SET prediction=$1,submitted_at=$2 WHERE token_hash=$3 AND group_id=$4 RETURNING id',[JSON.stringify(body.prediction),new Date(clock()).toISOString(),digest(auth.player),groupId]);
  if(!r.rows.length) fail(401,'הזיהוי האישי אינו תקין');return {ok:true};
 });},
 async login(body, ip) {
  await limit('admin',ip,10);
  const g=await db.transaction(game);
  const passwordHash=groupId===1?process.env.ADMIN_PASSWORD_HASH:g.admin_password_hash;
  if(!passwordHash) fail(503,'יש להגדיר סיסמת מנהל לקבוצה');
  if(!passwordMatches(body.password,passwordHash)) fail(401,'סיסמת מנהל שגויה');
  const t=token();
  await db.transaction(async tx=>{
   await tx.query('DELETE FROM ballot_admin_sessions WHERE expires_at<=$1',[new Date(clock()).toISOString()]);
   await tx.query('DELETE FROM ballot_rate_limits WHERE expires_at<=$1',[new Date(clock()).toISOString()]);
   await tx.query('INSERT INTO ballot_admin_sessions(token_hash,expires_at,group_id) VALUES($1,$2,$3)',[digest(t),new Date(clock()+8*3600000).toISOString(),groupId]);
  });return {token:t};
 },
 async logout(auth) {if(auth.admin) await db.query('DELETE FROM ballot_admin_sessions WHERE token_hash=$1 AND group_id=$2',[digest(auth.admin),groupId]);return {ok:true};},
 async configure(body,auth) {return db.transaction(async tx=>{
  await admin(tx,auth);const g=await game(tx);
  if(g.version!==body.version) fail(409,'ההגדרות השתנו. רעננו את המסך');
  const title=typeof body.title==='string'?body.title.trim():'';
  const parties=Array.isArray(body.parties)?body.parties.map(x=>typeof x==='string'?x.trim():''):[];
  if(!title||title.length>80||parties.length<2||parties.length>20||parties.some(x=>!x||x.length>60)||new Set(parties).size!==parties.length) fail(400,'יש להזין שם קבוצה ו-2 עד 20 רשימות שונות');
  const deadline=Date.parse(body.deadline);
  if(!Number.isFinite(deadline)) fail(400,'מועד סגירה אינו תקין');
  const changingParties=JSON.stringify(parties)!==JSON.stringify(g.parties);
  const count=(await tx.query('SELECT count(*) AS n FROM ballot_players WHERE group_id=$1',[groupId])).rows[0].n;
  if(changingParties&&Number(count)>0) fail(409,'לא ניתן לשנות רשימות לאחר הצטרפות משתתפים');
  if(g.published) fail(409,'לא ניתן לשנות הגדרות לאחר פרסום תוצאות');
  if(g.configured&&closed(g)&&deadline!==Date.parse(g.deadline)) fail(409,'לא ניתן לשנות את מועד הסגירה לאחר נעילה');
  if(!g.configured&&deadline<=clock()) fail(400,'יש לבחור מועד סגירה עתידי');
  await tx.query('UPDATE ballot_game SET title=$1,parties=$2,deadline=$3,configured=true,locked=$4,version=version+1,updated_at=now() WHERE id=$5',[title,JSON.stringify(parties),new Date(deadline).toISOString(),g.configured?g.locked:false,groupId]);
  await audit(tx,'configure',{title,parties,deadline:new Date(deadline).toISOString()});return {ok:true};
 });},
 async lock(body, auth) {return db.transaction(async tx=>{
  await admin(tx,auth);const g=await game(tx);
  if(body.version!==g.version) fail(409,'מצב הקבוצה השתנה. רעננו');
  if(!g.configured||g.published||Date.parse(g.deadline)<=clock()) fail(409,'לא ניתן לשנות נעילה במצב הנוכחי');
  if(typeof body.locked!=='boolean') fail(400,'מצב נעילה אינו תקין');
  await tx.query('UPDATE ballot_game SET locked=$1,version=version+1,updated_at=now() WHERE id=$2',[body.locked,groupId]);
  await audit(tx,body.locked?'lock':'reopen');return {ok:true};
 });},
 async results(body,auth) {return db.transaction(async tx=>{
  await admin(tx,auth);const g=await game(tx);
  if(!g.configured||body.version!==g.version) fail(409,'הגדרות הקבוצה השתנו. רעננו');
  if(!closed(g)) fail(409,'יש לנעול תחזיות לפני פרסום תוצאות');
  if(!vector(body.actual,g.parties.length)) fail(400,'תוצאות האמת חייבות להסתכם ב-120 מנדטים שלמים');
  const note=typeof body.note==='string'?body.note.trim():'';if(note.length>500) fail(400,'המקור או ההערה ארוכים מדי');
  await tx.query('UPDATE ballot_game SET actual=$1,results_note=$2,published=true,locked=true,published_at=$3,version=version+1,updated_at=now() WHERE id=$4',[JSON.stringify(body.actual),note,new Date(clock()).toISOString(),groupId]);
  await audit(tx,g.published?'correct_results':'publish_results',{actual:body.actual,note});return {ok:true};
 });}
 };
}

