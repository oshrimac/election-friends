import {AppError,digest,vector} from './service.mjs';
export const DEFAULT_PARTIES=["ישר","הליכוד","ביחד","הדמוקרטים","הרשימה המשותפת","ישראל ביתנו","עוצמה יהודית","יהדות התורה",'ש"ס',"הציונות הדתית + זהות",'רע"מ',"המילואימניקים והכלכלית","עמך ישראל","הציבור החרדי"];
export const APPROVED_ALIASES=new Map([['ש״ס','ש"ס'],['רע״מ','רע"מ'],['הציונות הדתית','הציונות הדתית + זהות'],['המילואימניקים/כלכלית','המילואימניקים והכלכלית']]);
export const partyKey=s=>s.normalize('NFKC').replace(/[״]/g,'"').replace(/[׳’]/g,"'").trim().replace(/\s+/g,' ').toLocaleLowerCase('he');
export function remap(values,from,to){
 if(!values)return null;
 const totals=new Map();
 from.forEach((p,i)=>totals.set(partyKey(p),(totals.get(partyKey(p))||0)+values[i]));
 return to.map(p=>totals.get(partyKey(p))||0);
}
export async function readElection(tx){
 await tx.query('SELECT pg_advisory_xact_lock_shared(7112027)');
 return (await tx.query('SELECT * FROM ballot_election WHERE id=1')).rows[0];
}
export async function centralAdmin(tx,auth,now=Date.now()){
 if(!auth?.admin)return false;
 return !!(await tx.query('SELECT token_hash FROM ballot_admin_sessions WHERE group_id=1 AND token_hash=$1 AND expires_at>$2',[digest(auth.admin),new Date(now).toISOString()])).rows.length;
}
async function labels(tx){
 return [...new Set([...DEFAULT_PARTIES,...(await tx.query('SELECT parties FROM ballot_game ORDER BY id')).rows.flatMap(g=>g.parties)])];
}
export async function electionEditor(tx,election){
 const groupRows=(await tx.query('SELECT slug,title,parties FROM ballot_game ORDER BY id')).rows;
 const all=await labels(tx),saved=new Map(election.mapping.map(m=>[m.source,m.target]));
 return {groupCount:groupRows.length,parties:DEFAULT_PARTIES,actual:remap(election.actual,election.parties,DEFAULT_PARTIES)||DEFAULT_PARTIES.map(()=>0),note:election.note,version:election.version,published:election.published,
  mappings:all.map(source=>({source,groups:groupRows.filter(g=>g.parties.includes(source)).map(g=>({title:g.title,slug:g.slug})),target:saved.has(source)?saved.get(source):(APPROVED_ALIASES.get(source)||DEFAULT_PARTIES.find(p=>partyKey(p)===partyKey(source))||'')}))};
}
export function projectGroup(parties,election){
 const mapping=new Map(election.mapping.map(m=>[m.source,m.target]));
 const extras=parties.filter(p=>mapping.get(p)===null);
 if(parties.some(p=>!mapping.has(p)))throw new AppError(503,'חסרה התאמה מאושרת לאחת המפלגות');
 const to=[...DEFAULT_PARTIES,...extras];
 const project=values=>{
  if(!values)return null;
  const out=to.map(()=>0);
  parties.forEach((p,i)=>{const target=mapping.get(p);const at=target===null?DEFAULT_PARTIES.length+extras.indexOf(p):DEFAULT_PARTIES.indexOf(target);out[at]+=values[i];});
  return out;
 };
 return {parties:to,actual:[...election.actual,...extras.map(()=>0)],extras,project};
}
async function validateMapping(tx,entries){
 const parties=DEFAULT_PARTIES;
  const sources=await labels(tx);
  if(!Array.isArray(entries)||entries.length!==sources.length)throw new AppError(400,'יש לאשר התאמה לכל שמות המפלגות לפני הפרסום');
  const mapped=new Map();
  for(const m of entries){
   if(!m||!sources.includes(m.source)||mapped.has(m.source)||(m.target!==null&&!parties.includes(m.target)))throw new AppError(400,'התאמת מפלגות אינה תקינה');
   if(parties.includes(m.source)&&m.target!==m.source)throw new AppError(400,'שם מהרשימה המרכזית חייב להישאר משויך לעצמו');
   mapped.set(m.source,m.target);
  }
  return sources.map(source=>({source,target:mapped.get(source)}));
}
export async function saveElectionMapping(db,body,auth,clock=()=>Date.now()){
 return db.transaction(async tx=>{
  if(!await centralAdmin(tx,auth,clock()))throw new AppError(403,'רק האדמין המרכזי רשאי לאשר התאמות');
  await tx.query('SELECT pg_advisory_xact_lock(7112027)');
  const previous=(await tx.query('SELECT * FROM ballot_election WHERE id=1 FOR UPDATE')).rows[0];
  if(previous.published)throw new AppError(409,'אחרי פרסום התוצאות יש לפרסם תיקון מלא כדי לשנות התאמות');
  if(body.electionVersion!==previous.version)throw new AppError(409,'ההתאמות השתנו. רעננו');
  const mapping=await validateMapping(tx,body.mapping);
  await tx.query('UPDATE ballot_election SET mapping=$1,version=version+1 WHERE id=1',[JSON.stringify(mapping)]);
  await tx.query("INSERT INTO ballot_audit(group_id,action,detail) VALUES(1,'central_mapping',$1)",[JSON.stringify({mapping})]);
  return {ok:true};
 });
}
export async function publishElection(db,body,auth,clock=()=>Date.now()){
 return db.transaction(async tx=>{
  if(!await centralAdmin(tx,auth,clock()))throw new AppError(403,'רק האדמין המרכזי רשאי לפרסם תוצאות אמת');
  // Group reads/writes take the shared lock first. Publishing cannot race a submission.
  await tx.query('SELECT pg_advisory_xact_lock(7112027)');
  const previous=(await tx.query('SELECT * FROM ballot_election WHERE id=1 FOR UPDATE')).rows[0];
  if(body.electionVersion!==previous.version)throw new AppError(409,'התוצאות המרכזיות השתנו. רעננו לפני הפרסום');
  const parties=DEFAULT_PARTIES;
  const validatedMapping=await validateMapping(tx,body.mapping);
  if(!Array.isArray(body.parties)||JSON.stringify(body.parties)!==JSON.stringify(parties))throw new AppError(409,'רשימת המפלגות השתנתה. רעננו ובדקו את המספרים');
  if(!vector(body.actual,parties.length))throw new AppError(400,'תוצאות האמת חייבות להסתכם ב-120 מנדטים שלמים');
  const note=typeof body.note==='string'?body.note.trim():'';
  if(note.length>500)throw new AppError(400,'ההערה ארוכה מדי');
  const publishedAt=new Date(clock()).toISOString();
  await tx.query('UPDATE ballot_election SET parties=$1,actual=$2,note=$3,published=true,published_at=$4,mapping=$5,version=version+1 WHERE id=1',[JSON.stringify(parties),JSON.stringify(body.actual),note,publishedAt,JSON.stringify(validatedMapping)]);
  await tx.query("INSERT INTO ballot_audit(group_id,action,detail) VALUES(1,$1,$2)",[previous.published?'central_correct_results':'central_publish_results',JSON.stringify({parties,actual:body.actual,note,mapping:validatedMapping})]);
  return {ok:true};
 });
}
