import {getSecret,setSecret,request} from './integrations.js';
import {audit} from './db.js';
const invalid=message=>Object.assign(new Error(message),{status:400});
export const EXTERNAL_SERVICES={github:{label:'GitHub',capability:'Read repositories and assigned issues'},notion:{label:'Notion',capability:'Search shared pages by title'},discord:{label:'Discord',capability:'Send to one webhook channel after explicit confirmation'}};
const choose=p=>{if(!Object.hasOwn(EXTERNAL_SERVICES,p))throw invalid('Unknown service');};
function webhook(value){let url;try{url=new URL(value);}catch{throw invalid('Enter a Discord webhook URL');}if(url.protocol!=='https:' || url.hostname!=='discord.com' || url.port || url.username || url.password || url.hash || url.search || !/^\/api(?:\/v10)?\/webhooks\/\d+\/[A-Za-z0-9_-]{20,200}$/.test(url.pathname))throw invalid('Use an official https://discord.com/api/webhooks/... URL');return url;}
export function externalStatus(db,key){return Object.entries(EXTERNAL_SERVICES).map(([provider,meta])=>({provider,...meta,configured:!!getSecret(db,`config:external:${provider}`,key)}));}
export function saveExternal(db,key,provider,input){
 choose(provider);const previous=getSecret(db,`config:external:${provider}`,key) || {};let value=input.credential || previous.credential;
 if(typeof value!=='string' || !value.trim() || value.length>3000 || /[\r\n]/.test(value))throw invalid('Enter a valid private credential');
 if(provider==='discord')value=webhook(value).href;
 setSecret(db,`config:external:${provider}`,{credential:value.trim()},key);audit(db,'external.configured',provider);return {ok:true};
}
export function removeExternal(db,provider){choose(provider);db.prepare('DELETE FROM secrets WHERE key=?').run(`config:external:${provider}`);audit(db,'external.disconnected',provider);return {ok:true};}
export async function readExternal(db,key,provider,{query='',kind='repositories'}={},send=request){
 choose(provider);const config=getSecret(db,`config:external:${provider}`,key);if(!config)throw invalid('Configure this connector first');
 if(provider==='github'){
  if(!['repositories','issues'].includes(kind))throw invalid('Choose repositories or issues');
  const data=await send('https://api.github.com/'+(kind==='issues'?'issues?filter=assigned&per_page=20':'user/repos?per_page=20&sort=updated'),{headers:{Authorization:`Bearer ${config.credential}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'Conclave'}});
  return {provider,items:data.map(v=>({id:v.id,title:v.full_name || v.title,url:v.html_url,state:v.state,description:v.description || ''}))};
 }
 if(provider==='notion'){
  if(typeof query!=='string' || query.length>200)throw invalid('Search must be at most 200 characters');
  const data=await send('https://api.notion.com/v1/search',{method:'POST',headers:{Authorization:`Bearer ${config.credential}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'},body:JSON.stringify({query,page_size:20,filter:{value:'page',property:'object'},sort:{direction:'descending',timestamp:'last_edited_time'}})});
  return {provider,items:data.results.map(p=>({id:p.id,title:Object.values(p.properties || {}).find(v=>v.type==='title')?.title?.map(t=>t.plain_text || '').join('') || 'Untitled',url:p.url,updated_at:p.last_edited_time})),has_more:data.has_more};
 }
 // Inspecting a webhook sends no message. Never return its token or full URL.
 const result=await send(webhook(config.credential),{});return {provider,name:result.name,channel_id:result.channel_id};
}
export async function sendDiscord(db,key,input,send=request){
 if(input.confirmed!==true)throw invalid('Confirm the final Discord message before sending');
 if(typeof input.text!=='string' || !input.text.trim() || input.text.length>2000)throw invalid('Message must contain 1–2000 characters');
 const config=getSecret(db,'config:external:discord',key);if(!config)throw invalid('Configure Discord first');
 const url=webhook(config.credential);url.searchParams.set('wait','true');
 // An uncertain provider response is not retried: check the channel first.
 const sent=await send(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({content:input.text,allowed_mentions:{parse:[]}})});audit(db,'external.discord_sent',String(sent.id));return {ok:true,id:sent.id};
}
