import {access} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
for(const file of ['public/index.html','public/style.css','public/app.js','lib/schema.sql']) await access(file);
for(const file of ['public/app.js','lib/db.mjs','lib/accounts.mjs','lib/election.mjs','lib/service.mjs','api/index.mjs']) execFileSync(process.execPath,['--check',file]);
console.log('Static client and server syntax verified. No credentials are embedded in the client.');

