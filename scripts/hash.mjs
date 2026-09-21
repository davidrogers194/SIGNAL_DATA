import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
if(!process.argv[2])throw Error('Usage: node scripts/hash.mjs path/to/document.json');
const p=JSON.parse(await readFile(process.argv[2],'utf8'));delete p.content_hash;p.content_hash=createHash('sha256').update(canonical(p),'utf8').digest('hex');await writeFile(process.argv[2],JSON.stringify(p,null,2)+'\n');console.log(p.content_hash);
