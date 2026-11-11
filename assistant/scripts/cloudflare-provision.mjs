// Receive the provisioning token over stdin; never save it or place it in argv.
import { createInterface } from 'node:readline';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
if(process.stdin.isTTY)process.stdin.setRawMode(true);
const rl=createInterface({input:process.stdin,terminal:false});
console.log('Waiting for Cloudflare API token on stdin (not echoed).');
const token=await new Promise(resolve=>rl.once('line',resolve));rl.close();if(process.stdin.isTTY)process.stdin.setRawMode(false);process.stdin.pause();
async function api(path,method='GET',body){
  const res=await fetch(`https://api.cloudflare.com/client/v4${path}`,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(25000)});
  const data=await res.json();if(!res.ok||!data.success)throw new Error(`Cloudflare ${method} ${path}: HTTP ${res.status}; ${(data.errors||[]).map(e=>`${e.code}: ${e.message}`).join('; ')}`);return data.result;
}
try{
  const verified=await api('/user/tokens/verify');console.log(JSON.stringify({token_status:verified.status}));
  const zones=await api('/zones?name=aten-systems.site');if(zones.length!==1)throw new Error('Expected exactly one accessible aten-systems.site zone');
  const zone=zones[0],account=zone.account.id;
  const dns=await api(`/zones/${zone.id}/dns_records?name=jarvis.aten-systems.site`);
  const tunnels=await api(`/accounts/${account}/cfd_tunnel?name=jarvis-private-assistant&is_deleted=false`);
  console.log(JSON.stringify({zone_id:zone.id,account_id:account,existing_jarvis_dns:dns.map(d=>({id:d.id,type:d.type,content:d.content})),existing_jarvis_tunnels:tunnels.map(t=>({id:t.id,name:t.name,status:t.status}))}));
  if(!process.argv.includes('--provision'))process.exit(0);
  if(tunnels.length>1)throw new Error('Multiple Jarvis tunnels found; refusing ambiguous configuration');
  let tunnel=tunnels[0];
  if(dns.length&&(!tunnel||dns.length!==1||dns[0].type!=='CNAME'||dns[0].content!==`${tunnel.id}.cfargotunnel.com`))throw new Error('Existing Jarvis DNS targets a different service; refusing to overwrite it');
  if(!tunnel)tunnel=await api(`/accounts/${account}/cfd_tunnel`,'POST',{name:'jarvis-private-assistant',config_src:'cloudflare'});
  await api(`/accounts/${account}/cfd_tunnel/${tunnel.id}/configurations`,'PUT',{config:{ingress:[{hostname:'jarvis.aten-systems.site',service:'http://127.0.0.1:3210',originRequest:{httpHostHeader:'jarvis.aten-systems.site'}},{service:'http_status:404'}]}});
  const connector=await api(`/accounts/${account}/cfd_tunnel/${tunnel.id}/token`);
  mkdirSync('private/provisioning',{recursive:true,mode:0o700});
  writeFileSync('private/provisioning/tunnel-token',connector+'\n',{mode:0o600});chmodSync('private/provisioning/tunnel-token',0o600);
  if(!dns.length)await api(`/zones/${zone.id}/dns_records`,'POST',{type:'CNAME',name:'jarvis',content:`${tunnel.id}.cfargotunnel.com`,proxied:true,ttl:1});
  writeFileSync('private/provisioning/metadata.json',JSON.stringify({tunnel_id:tunnel.id,account_id:account,zone_id:zone.id,hostname:'jarvis.aten-systems.site'},null,2),{mode:0o600});
  console.log(JSON.stringify({provisioned:true,tunnel_id:tunnel.id,url:'https://jarvis.aten-systems.site',connector_saved_privately:true}));
}catch(e){console.error(e.message);process.exitCode=1;}
