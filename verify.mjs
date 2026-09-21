// Read-only downstream checks. Verification never edits research or market data.
export function expectedResearchSlot(now = new Date()) {
 const fmt = new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'short',hour:'2-digit',hourCycle:'h23'});
 for(let h=0;h<192;h++){
  const date=new Date(Math.floor(now.getTime()/3600000)*3600000-h*3600000);
  const p=Object.fromEntries(fmt.formatToParts(date).map(x=>[x.type,x.value]));
  if(['Mon','Wed','Sat','Sun'].includes(p.weekday)&&p.hour==='07')return date.toISOString();
 }
 throw Error('Research schedule calculation failed');
}
export async function verifyPipeline(env,readers){
 const now=new Date(),stages={},conditions={};let research=null,commit=null;
 const check=(name,ok,actual,expected,last=null,status=null)=>{stages[name]={status:status||(ok?'PASS':'FAIL'),expected,actual,last_success_at:ok?(last??now.toISOString()):last};return !!ok};
 const fetchSite=async path=>{const url=new URL(path,env.SIGNAL_SITE_URL);if(url.protocol!=='https:')throw Error('SIGNAL_SITE_URL must use HTTPS');const r=await (env.SIGNAL_SITE?env.SIGNAL_SITE.fetch.bind(env.SIGNAL_SITE):fetch)(url,{headers:{'User-Agent':'SIGNAL-Pipeline-Verifier','Cache-Control':'no-cache'},signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(path+': HTTP '+r.status);return r;};
 try{
  commit=await readers.github(env,'/commits/'+encodeURIComponent(env.GITHUB_BRANCH||'main'));
  research=await readers.document(env,'research',commit.sha);
  const archive=await readers.github(env,`/contents/week/${research.season}-W${String(research.week).padStart(2,'0')}/research.json?ref=${commit.sha}`);
  const archived=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(archive.content.replace(/\s/g,'')),c=>c.charCodeAt(0))));
  const {validate}=await import('./schema.mjs');await validate(archived,'research');
  conditions.github_current=check('GitHub handoff',archived.content_hash===research.content_hash,research.content_hash,'Valid latest and matching week archive');
  try{const file=await readers.github(env,'/contents/latest/research-audit.json?ref='+commit.sha);const audit=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g,'')),c=>c.charCodeAt(0))));const valid=audit.research_content_hash===research.content_hash&&['PASS','FAIL'].includes(audit.status)&&Array.isArray(audit.findings)&&Array.isArray(audit.sources_checked)&&audit.sources_checked.length>0&&Number.isFinite(Date.parse(audit.reviewed_at))&&Date.parse(audit.reviewed_at)<=now.getTime()+300000;check('Research content review',valid&&audit.status==='PASS',valid?audit.findings:'Missing or mismatched content review','Matching source-backed substantive research review; schema validation alone is insufficient',valid&&audit.status==='PASS'?audit.reviewed_at:null);}catch(e){check('Research content review',false,e.message,'Matching substantive research review in latest/research-audit.json');}
  const slot=expectedResearchSlot(now),due=Date.parse(slot)+60*60*1000;
  check('Research generation',Date.parse(research.generated_at)>=Date.parse(slot),research.generated_at,`Research generated after ${slot}; one-hour delivery grace`,research.generated_at,Date.parse(research.generated_at)<Date.parse(slot)?(now.getTime()<due?'NOT EXPECTED':'STALE'):null);
 }catch(e){conditions.github_current=check('GitHub handoff',false,e.message,'Readable valid research and archive');check('Research generation',false,'Cannot validate latest research','Current scheduled research');}
 check('Research schedule',!!env.RESEARCH_TASK_URL&&Number.isFinite(Date.parse(env.RESEARCH_SCHEDULE_VERIFIED_AT))&&now.getTime()-Date.parse(env.RESEARCH_SCHEDULE_VERIFIED_AT)<7*86400000,{task:env.RESEARCH_TASK_URL??null,observed_at:env.RESEARCH_SCHEDULE_VERIFIED_AT??null},'Active ChatGPT task Mon/Wed/Sat/Sun 07:00 America/Chicago; UI verification expires after seven days',env.RESEARCH_SCHEDULE_VERIFIED_AT);
 const hash=research?.content_hash;
 try{
  const row=research?await env.DB.prepare("SELECT content_hash,imported_at FROM signal_github_handoff WHERE kind='research' AND season=? AND week=?").bind(research.season,research.week).first():null;
  conditions.importer_current=check('GitHub → importer',!!hash&&row?.content_hash===hash,row?.content_hash??'Missing',hash??'Validated GitHub hash',row?.imported_at);
  const p=research?await env.DB.prepare('SELECT payload_json FROM weekly_research WHERE week_key=?').bind(`${research.season}-W${String(research.week).padStart(2,'0')}`).first():null;
  const projection=p?JSON.parse(p.payload_json):null;
  conditions.d1_current=check('Importer → D1',!!hash&&projection?.content_hash===hash,projection?.content_hash??'Missing',hash??'Validated GitHub hash');
 }catch(e){conditions.importer_current=false;conditions.d1_current=check('Importer → D1',false,e.message,'Matching D1 projection');}
 try{const api=await (await fetchSite('/api/data/weekly-brief')).json();conditions.api_current=check('D1 → API',!!hash&&api.brief?.content_hash===hash,api.brief?.content_hash??'Missing hash',hash??'Validated GitHub hash');}catch(e){conditions.api_current=check('D1 → API',false,e.message,'Matching API hash');}
 try{const html=await (await fetchSite('/')).text();conditions.frontend_current=check('API → frontend',!!hash&&html.includes(`data-research-hash="${hash}"`)&&html.includes('Focus Games')&&research.payload.games.slice(0,4).every(g=>html.includes(`data-game-id="${g.eventId}"`)),html.includes(hash??'__missing__')?'Version present in HTML':'Version absent','Server-rendered current research, all game IDs; browser interaction tested separately');}catch(e){conditions.frontend_current=check('API → frontend',false,e.message,'Rendered current research');}
 const states=(await env.DB.prepare('SELECT * FROM sync_state').all()).results;
 const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',weekday:'short',hour:'2-digit',hourCycle:'h23'}).formatToParts(now).map(x=>[x.type,x.value]));
 for(const [name,key,age] of [['markets','market_current',parts.weekday==='Sun'&&Number(parts.hour)>=12?6*60000:75*60000],['injuries','injuries_current',75*60000],['weather','weather_current',20*60000]]){
  const s=states.find(s=>s.source===name);const fresh=!!s?.last_success_at&&now.getTime()-Date.parse(s.last_success_at)<=age&&s.record_count>0&&s.status!=='error';
  conditions[key]=check(name[0].toUpperCase()+name.slice(1),fresh,s?.last_error||`${s?.status??'Not configured'}; ${s?.record_count??0} records`,`Successful nonempty refresh within ${age/60000} minutes`,s?.last_success_at,fresh?null:s?.last_success_at?'STALE':'FAIL');
 }
 for(const [name,path,key]of [['Games','/api/data/games','games'],['Players','/api/data/players','players'],['Prop Board','/api/data/prop-board?limit=5000','cards']]){
  try{const data=await(await fetchSite(path)).json();check(name,Array.isArray(data[key])&&data[key].length>0,data[key]?.length??0,'Nonempty successful production response');}catch(e){check(name,false,e.message,'Successful production response');}
 }
 const success=Object.values(conditions).every(value=>value===true)&&Object.values(stages).every(s=>['PASS','NOT EXPECTED'].includes(s.status));
 const report={checked_at:now.toISOString(),success,conditions,stages,research:research?{season:research.season,week:research.week,model_version:research.model_version,content_hash:hash,frozen:research.frozen,generated_at:research.generated_at,commit_sha:commit.sha}:null};
 await env.DB.prepare("INSERT INTO raw_snapshots(kind,source,source_key,captured_at,payload_json) VALUES ('pipeline_verification','SIGNAL',?,?,?)").bind(hash??'unknown',now.toISOString(),JSON.stringify(report)).run();
 await env.DB.prepare("INSERT INTO sync_state(source,last_attempt_at,last_success_at,status,last_error) VALUES ('pipeline-verification',?,?,?,?) ON CONFLICT(source) DO UPDATE SET last_attempt_at=excluded.last_attempt_at,last_success_at=CASE WHEN excluded.status='healthy' THEN excluded.last_success_at ELSE sync_state.last_success_at END,status=excluded.status,last_error=excluded.last_error").bind(now.toISOString(),success?now.toISOString():null,success?'healthy':'error',success?null:Object.entries(stages).filter(([,v])=>!['PASS','NOT EXPECTED'].includes(v.status)).map(([k,v])=>`${k}: ${v.status}: ${v.actual}`).join('; ').slice(0,2000)).run();
 return report;
}
