import {getSecret,setSecret} from './integrations.js';
import {audit,transaction} from './db.js';
const invalid=message=>Object.assign(new Error(message),{status:400});
export const MODEL_PROVIDERS=['claude-cli','codex-cli','antigravity-cli','openai','anthropic'];
export function modelSettings(db,key){
 const config=getSecret(db,'config:model',key) || {};
 return {provider:config.provider || '',model:config.model || '',choices:MODEL_PROVIDERS.map(provider=>({provider,configured:provider.endsWith('-cli') || !!getSecret(db,`config:model:${provider}`,key)?.api_key || (config.provider===provider && !!config.api_key)}))};
}
export function switchModel(db,key,{provider,model='',api_key}={}){
 if(!MODEL_PROVIDERS.includes(provider))throw invalid('Choose a supported model provider');
 if(typeof model!=='string' || model.length>200 || /[\r\n]/.test(model))throw invalid('Enter a valid model ID');
 const current=getSecret(db,'config:model',key);
 const saved=(current?.provider===provider?current:getSecret(db,`config:model:${provider}`,key)) || {};
 const config={provider,model:provider.endsWith('-cli')?model.trim():(model.trim() || saved.model || ''),...(!provider.endsWith('-cli')?{api_key:api_key || saved.api_key}: {})};
 if(api_key!==undefined && (typeof api_key!=='string' || api_key.length>2000))throw invalid('Invalid API key');
 if(!provider.endsWith('-cli') && (!config.api_key || !config.model))throw invalid('Configure this API provider and its model in Connectors first');
 transaction(db,()=>{if(current?.provider)setSecret(db,`config:model:${current.provider}`,current,key);setSecret(db,`config:model:${provider}`,config,key);setSecret(db,'config:model',config,key);db.prepare("INSERT INTO connections VALUES('model','read','configured',NULL,?) ON CONFLICT(provider) DO UPDATE SET status='configured',updated_at=excluded.updated_at").run(Date.now());audit(db,'model.selected',provider);});
 return modelSettings(db,key);
}
export function modelCommand(db,key,text){
 const match=text.match(/^\/model(?:\s+([\w-]+)(?:\s+(.+))?)?\s*$/i);if(!match)return null;
 if(!match[1]){const s=modelSettings(db,key);return `Current model: ${s.provider || 'not configured'} · ${s.model || 'default'}. Switch with /model claude-cli, /model codex-cli, /model antigravity-cli, or /model <provider> <model-id>. API providers must be configured in Connectors first.`;}
 const provider=({claude:'claude-cli',codex:'codex-cli',antigravity:'antigravity-cli'})[match[1]] || match[1];
 const s=switchModel(db,key,{provider,model:match[2] || ''});return `Model changed to ${s.provider} · ${s.model || 'default'}. Your Jarvis conversation and memories are retained.`;
}
