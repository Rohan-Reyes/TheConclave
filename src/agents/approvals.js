// Pending permission requests from agents, answered in the browser.
// Flow: Claude → approval_prompt MCP tool → POST /api/approvals → user clicks
// Allow/Deny → the MCP tool polls GET /api/approvals/:id and returns the answer.
import { EventEmitter } from 'node:events';
import { newId, now } from '../db.js';

export const approvalBus = new EventEmitter();
const pending = new Map();   // id -> approval
const TTL = 15 * 60_000;

const summary = (tool, input = {}) => {
  if (input.command) return `$ ${input.command}`;
  if (input.file_path) return `${tool} ${input.file_path}`;
  if (input.url) return `${tool} ${input.url}`;
  const s = JSON.stringify(input);
  return `${tool} ${s.length > 300 ? s.slice(0, 300) + '…' : s}`;
};

export function createApproval({ threadId, messageId, agent, toolName, input }, autoAllow = []) {
  const a = {
    id: newId(), threadId, messageId, agent, toolName, input, summary: summary(toolName, input),
    status: autoAllow.includes(toolName) ? 'allowed' : 'pending', created: now(), auto: autoAllow.includes(toolName),
  };
  pending.set(a.id, a);
  approvalBus.emit('change', a);
  setTimeout(() => {
    const cur = pending.get(a.id);
    if (cur?.status === 'pending') decide(a.id, 'denied', 'No answer within 15 minutes');
    setTimeout(() => pending.delete(a.id), 60_000);
  }, TTL).unref();
  return a;
}

export function decide(id, status, message = '') {
  const a = pending.get(id);
  if (!a) throw Object.assign(new Error('Request expired'), { status: 404 });
  if (a.status !== 'pending') return a;
  a.status = status === 'allowed' ? 'allowed' : 'denied';
  a.message = message;
  a.decided = now();
  approvalBus.emit('change', a);
  return a;
}

export const getApproval = id => pending.get(id) || null;
export const listApprovals = threadId => [...pending.values()].filter(a => a.threadId === threadId && a.status === 'pending');

// Deny everything still waiting for a run that has ended or was stopped.
export function denyForMessage(messageId) {
  for (const a of pending.values()) if (a.messageId === messageId && a.status === 'pending') decide(a.id, 'denied', 'Run ended');
}
