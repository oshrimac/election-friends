import {randomBytes,scryptSync} from 'node:crypto';
import readline from 'node:readline';
if(!process.stdin.isTTY) {console.error('Run this command in an interactive terminal. Passwords are never accepted as arguments.');process.exit(1);}
console.log('Enter a new admin password (at least 4 characters; input is hidden):');
const rl=readline.createInterface({input:process.stdin,output:process.stdout,terminal:true});
rl._writeToOutput=()=>{};
rl.question('',password=>{rl.close();if(password.length<4||password.length>256) {console.error('\nUse 4–256 characters.');process.exitCode=1;return;}
const salt=randomBytes(16).toString('hex');console.log('\nStore this value as the secret ADMIN_PASSWORD_HASH in Vercel:\nscrypt$'+salt+'$'+scryptSync(password,salt,64).toString('hex'));});
