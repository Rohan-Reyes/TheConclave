// Jarvis-side client for the coding-agent CLIs. In production the Jarvis service account
// cannot see the owner's CLI logins, so requests go to the agent bridge over a Unix socket
// (AGENT_BRIDGE_SOCKET). Without a socket (local development) the CLI runs in-process.
import { request } from 'node:http';
import { resolve } from 'node:path';
import { AGENTS, runAgent, agentInventory } from './agent-bridge.js';

export const CLI_PROVIDERS = Object.keys(AGENTS);
const fail = (message, status = 409) => Object.assign(new Error(message), { status });

function bridge(method, path, body, timeout = 200_000) {
  const socketPath = process.env.AGENT_BRIDGE_SOCKET;
  return new Promise((done, reject) => {
    const req = request({ socketPath, method, path, headers: { 'Content-Type': 'application/json' }, timeout }, res => {
      let data = ''; res.setEncoding('utf8'); res.on('data', c => { data += c; });
      res.on('end', () => { let parsed; try { parsed = JSON.parse(data); } catch { return reject(fail('Agent bridge returned an invalid response', 502)); } res.statusCode === 200 ? done(parsed) : reject(fail(parsed.error || 'Agent bridge request failed', res.statusCode === 429 ? 429 : 502)); });
    });
    req.on('timeout', () => req.destroy(fail('Agent bridge timed out', 504)));
    req.on('error', e => reject(e.status ? e : fail('Agent bridge is not running. Start jarvis-agents.service on the server.', 503)));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function cliInventory() {
  if (process.env.AGENT_BRIDGE_SOCKET) {
    try { return await bridge('GET', '/agents', undefined, 30_000); }
    catch (e) { return CLI_PROVIDERS.map(provider => ({ provider, label: AGENTS[provider].label, installed: false, usable_as_model: false, note: e.message })); }
  }
  return agentInventory();
}

export async function cliReply(provider, model, prompt) {
  if (!AGENTS[provider]) throw fail('This CLI has no verified text-only adapter');
  if (process.env.AGENT_BRIDGE_SOCKET) return (await bridge('POST', '/reply', { provider, model, prompt })).text;
  return runAgent(provider, model, prompt, { workRoot: resolve(process.env.DATA_DIR || './private', 'cli-workspaces') });
}
