import {validate,jsonSchemas} from './schema.mjs';
const MAX_BYTES=750000;
async function github(env,path){
 const repo=new URL(env.GITHUB_REPOSITORY_URL);
 if(repo.origin!=='https://github.com'||!/^\/[\w.-]+\/[\w.-]+\/?$/.test(repo.pathname))throw Error('Invalid GITHUB_REPOSITORY_URL');
 const headers={'User-Agent':'SIGNAL-GitHub-Importer','Accept':'application/vnd.github+json'};
 if(env.GITHUB_TOKEN)headers.Authorization='Bearer '+env.GITHUB_TOKEN;
 const r=await fetch('https://api.github.com/repos'+repo.pathname.replace(/\/$/,'')+path,{headers,signal:AbortSignal.timeout(15000),redirect:'manual'});
 if(!r.ok)throw Error('GitHub HTTP '+r.status+' for '+path.split('?')[0]);
 const reader=r.body.getReader();let size=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX_BYTES){await reader.cancel();throw Error('GitHub document exceeds 750 KB');}chunks.push(value);}
 const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}return JSON.parse(new TextDecoder().decode(bytes));
}
async function document(env,kind,sha){const file=await github(env,'/contents/latest/'+kind+'.json?ref='+sha);if(file.encoding!=='base64'||typeof file.content!=='string')throw Error('Expected a GitHub JSON file');const bytes=Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0));return validate(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)),kind);}
const prepare=(env,sql,...args)=>env.DB.prepare(sql).bind(...args);
export async function runImport(env){
 const now=new Date().toISOString(),lease=crypto.randomUUID();
 await prepare(env,"INSERT OR IGNORE INTO sync_state(source,status) VALUES ('github-handoff-lock','idle')").run();
 const lock=await prepare(env,"UPDATE sync_state SET status=?,next_due_at=? WHERE source='github-handoff-lock' AND (next_due_at IS NULL OR next_due_at<?)",lease,new Date(Date.now()+120000).toISOString(),now).run();
 if(!lock.meta.changes)return {state:'busy',rows_written:0};
 try{
  await prepare(env,"INSERT INTO sync_state(source,last_attempt_at,status) VALUES ('github-handoff',?,'running') ON CONFLICT(source) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,status='running'",now).run();
  const commit=await github(env,'/commits/'+encodeURIComponent(env.GITHUB_BRANCH||'main'));
  if(!/^[a-f0-9]{40}$/.test(commit.sha))throw Error('Invalid GitHub commit');
  const research=await document(env,'research',commit.sha),results=await document(env,'results',commit.sha);
  if(results.research_content_hash){const match=research.content_hash===results.research_content_hash&&research.season===results.season&&research.week===results.week;const archived=match?null:await prepare(env,"SELECT id FROM raw_snapshots WHERE kind='github_research' AND source_key=? AND json_extract(payload_json,'$.season')=? AND json_extract(payload_json,'$.week')=? LIMIT 1",results.research_content_hash,results.season,results.week).first();if(!match&&!archived)throw Error('Results reference unknown research version');}
  const writes=[],changed=[];
  for(const p of [research,results]){
   const old=await prepare(env,'SELECT * FROM signal_github_handoff WHERE kind=? AND season=? AND week=?',p.kind,p.season,p.week).first();
   if(old?.content_hash===p.content_hash)continue;
   if(old&&Date.parse(p.generated_at)<=Date.parse(old.generated_at))throw Error(p.kind+': older or conflicting generated_at');
   if(p.kind==='research'&&old?.frozen)throw Error('Research for this week is frozen');
   const payload=JSON.stringify(p),weekKey=p.season+'-W'+String(p.week).padStart(2,'0');let rows=1;
   writes.push(prepare(env,'INSERT INTO raw_snapshots(kind,source,source_key,captured_at,payload_json) VALUES (?,?,?,?,?)','github_'+p.kind,env.GITHUB_REPOSITORY_URL,p.content_hash,now,payload));
   if(p.kind==='research'&&p.payload.games.length){
    const projection={...p.payload,weekKey,publishedAt:p.generated_at,source:'GitHub research · '+p.model_version,content_hash:p.content_hash,frozen:p.frozen,games:p.payload.games.map(game=>{const picks=p.payload.qualifiedProps.filter(prop=>prop.eventId===game.eventId&&prop.grade!=='Pass').sort((a,b)=>b.score-a.score);const best=picks[0];return {...game,grade:best?.grade??'Research',score:best?.score??null,beneficiaries:[...new Set(picks.map(x=>x.player))],propTypes:[...new Set(picks.map(x=>x.marketKey.replace(/^player_/,'').replaceAll('_',' ')))],sources:game.sources.map(source=>({label:source.title,url:source.url,published_at:source.published_at}))};})};
    writes.push(prepare(env,"INSERT INTO weekly_research(week_key,title,dek,published_at,source,payload_json) VALUES (?,?,?,?,?,?) ON CONFLICT(week_key) DO UPDATE SET title=excluded.title,dek=excluded.dek,published_at=excluded.published_at,source=excluded.source,payload_json=excluded.payload_json WHERE excluded.published_at>weekly_research.published_at",weekKey,p.payload.title,p.payload.dek,p.generated_at,projection.source,JSON.stringify(projection)));rows++;
   }
   if(p.kind==='results'){
    writes.push(prepare(env,"DELETE FROM stat_snapshots WHERE entity_type='github_result' AND season=? AND week=?",p.season,p.week));
    writes.push(prepare(env,"INSERT INTO stat_snapshots(entity_type,entity_id,season,week,source,captured_at,payload_json) SELECT 'github_result',json_extract(value,'$.id'),?,?,?, ?,json_set(value,'$.research_content_hash',?) FROM json_each(?)",p.season,p.week,'GitHub postgame · '+p.model_version,p.generated_at,p.research_content_hash,JSON.stringify(p.payload.results)));rows+=p.payload.results.length;
   }
   writes.push(prepare(env,'INSERT INTO signal_github_handoff(kind,season,week,content_hash,model_version,generated_at,imported_at,frozen,rows_written,commit_sha,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(kind,season,week) DO UPDATE SET content_hash=excluded.content_hash,model_version=excluded.model_version,generated_at=excluded.generated_at,imported_at=excluded.imported_at,frozen=excluded.frozen,rows_written=excluded.rows_written,commit_sha=excluded.commit_sha,payload_json=excluded.payload_json',p.kind,p.season,p.week,p.content_hash,p.model_version,p.generated_at,now,p.kind==='research'&&p.frozen?1:0,rows,commit.sha,payload));
   changed.push({kind:p.kind,season:p.season,week:p.week,content_hash:p.content_hash,rows_written:rows});
  }
  if(!changed.length){await prepare(env,"UPDATE sync_state SET status='unchanged',last_error=NULL WHERE source='github-handoff'").run();return {state:'unchanged',rows_written:0};}
  const rows=changed.reduce((sum,p)=>sum+p.rows_written,0);
  writes.push(prepare(env,"UPDATE sync_state SET status='healthy',last_success_at=?,record_count=?,last_error=NULL WHERE source='github-handoff'",now,rows));
  await env.DB.batch(writes);
  return {state:'imported',commit_sha:commit.sha,rows_written:rows,documents:changed};
 }catch(error){const message=error instanceof Error?error.message:'Import failed';await prepare(env,"UPDATE sync_state SET status='error',last_error=? WHERE source='github-handoff'",message.slice(0,2000)).run();return {state:'error',error:message};}
 finally{await prepare(env,"UPDATE sync_state SET status='idle',next_due_at=NULL WHERE source='github-handoff-lock' AND status=?",lease).run();}
}
export default {
 async fetch(request,env){
  const path=new URL(request.url).pathname;
  if(request.method==='GET'&&path==='/api/import/schema')return Response.json(jsonSchemas);
  if(request.method==='GET'&&path==='/api/import/status'){
   const state=await prepare(env,"SELECT last_attempt_at,last_success_at,status,record_count AS rows_written,last_error AS error FROM sync_state WHERE source='github-handoff'").first();
   const docs=await prepare(env,'SELECT kind,season,week,content_hash,model_version,generated_at,imported_at AS last_success_at,rows_written,frozen,commit_sha FROM signal_github_handoff ORDER BY imported_at DESC LIMIT 20').all();
   return Response.json({repository:env.GITHUB_REPOSITORY_URL,branch:env.GITHUB_BRANCH||'main',...state,documents:docs.results},{headers:{'Cache-Control':'no-store'}});
  }
  if(request.method==='POST'&&path==='/api/import/run'){
   if(!env.SIGNAL_AUTOMATION_TOKEN||request.headers.get('Authorization')!=='Bearer '+env.SIGNAL_AUTOMATION_TOKEN)return Response.json({error:'Authorized importer token required'},{status:401});
   const result=await runImport(env);return Response.json(result,{status:result.state==='error'?422:result.state==='busy'?409:200});
  }
  return Response.json({error:'Not found'},{status:404});
 },
 async scheduled(_event,env,ctx){ctx.waitUntil(runImport(env).then(result=>{console.log(JSON.stringify({event:'github-handoff',state:result.state}));}));}
};
