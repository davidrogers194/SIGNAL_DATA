import { z } from 'zod/v4';
const text = z.string().trim().min(1).max(6000);
const source = z.object({title:text,url:z.string().url().startsWith('https://'),published_at:z.string().datetime()}).strict();
const game = z.object({eventId:text,matchup:text,headline:text,thesis:text,defensiveWeakness:text,offensiveResponse:text,personnelContext:text,gameflow:text,breaker:text,sources:z.array(source).min(1).max(20)}).strict();
const pick = z.object({eventId:text,player:text,marketKey:z.string().startsWith('player_'),side:z.enum(['OVER','UNDER']),line:z.number().finite(),score:z.number().min(0).max(100),grade:z.enum(['A','A-','B+','B','Pass']),reason:text,tags:z.array(text).max(20),sources:z.array(source).min(1).max(20)}).strict();
const base = {schema_version:z.literal('1.0'),season:z.number().int().min(2000).max(2100),week:z.number().int().min(1).max(22),model_version:z.string().min(1).max(100),generated_at:z.string().datetime(),content_hash:z.string().regex(/^[a-f0-9]{64}$/)};
export const researchSchema = z.object({...base,kind:z.literal('research'),frozen:z.boolean(),payload:z.object({title:text,dek:text,games:z.array(game).max(16),qualifiedProps:z.array(pick).max(50)}).strict()}).strict();
export const resultsSchema = z.object({...base,kind:z.literal('results'),research_content_hash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),payload:z.object({results:z.array(z.object({id:text,event_id:text,player_id:text,player:text,market_key:z.string().startsWith('player_'),side:z.enum(['OVER','UNDER']),line:z.number().finite(),actual:z.number().finite().nullable(),outcome:z.enum(['win','loss','push','void','pending']),settled_at:z.string().datetime().nullable(),sources:z.array(source).min(1).max(20)}).strict()).max(300),learning_notes:z.array(z.object({id:text,finding:text,evidence_result_ids:z.array(text).min(1),methodology:text}).strict()).max(50)}).strict()}).strict();
export const schemas={research:researchSchema,results:resultsSchema};
export const canonical = value => Array.isArray(value)?'['+value.map(canonical).join(',')+']':value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}':JSON.stringify(value);
export async function hashDocument(value){const {content_hash,...body}=value;return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(body))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export async function validate(value,kind,now=Date.now()){
 const p=schemas[kind].parse(value);
 if(Date.parse(p.generated_at)>now+300000)throw Error(kind+': generated_at is in the future');
 if(p.content_hash!==await hashDocument(p))throw Error(kind+': content_hash mismatch');
 if(kind==='research'){
  if(!p.payload.games.length&&(p.payload.qualifiedProps.length||p.frozen))throw Error('Empty research must be unfrozen with no picks');
  const ids=p.payload.games.map(g=>g.eventId);if(new Set(ids).size!==ids.length)throw Error('Duplicate research event IDs');
  for(const pick of p.payload.qualifiedProps)if(!ids.includes(pick.eventId))throw Error('Pick requires a researched event');
 }else{
  const ids=p.payload.results.map(r=>r.id);if(new Set(ids).size!==ids.length)throw Error('Duplicate result IDs');
  if((ids.length||p.payload.learning_notes.length)&&!p.research_content_hash)throw Error('Results require research_content_hash');
  for(const r of p.payload.results){if(['win','loss','push'].includes(r.outcome)){if(r.actual===null||r.settled_at===null)throw Error('Settled results need actual and settled_at');const expected=r.actual===r.line?'push':(r.side==='OVER'?r.actual>r.line:r.actual<r.line)?'win':'loss';if(r.outcome!==expected)throw Error('Result outcome contradicts actual');}}
  for(const note of p.payload.learning_notes)if(note.evidence_result_ids.some(id=>!ids.includes(id)))throw Error('Learning references missing result');
 }
 return p;
}
export const jsonSchemas=Object.fromEntries(Object.entries(schemas).map(([k,s])=>[k,z.toJSONSchema(s)]));
