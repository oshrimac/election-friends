import http from 'node:http';
import {readFile} from 'node:fs/promises';
import handler from './api/index.mjs';
export function createServer() {return http.createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path.startsWith('/api/')) return handler(req,res);
 const file=path==='/app.js'?'app.js':path==='/style.css'?'style.css':['/','/admin'].includes(path)?'index.html':null;
 if(!file) {res.writeHead(404);return res.end('Not found');}
 try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");res.end(await readFile(new URL('./public/'+file,import.meta.url)));}
 catch {res.writeHead(500);res.end('Server error');}
});}
if(process.argv[1]===new URL(import.meta.url).pathname) createServer().listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('Ballot ready on http://localhost:'+(process.env.PORT||3000)));
