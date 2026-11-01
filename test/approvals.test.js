import test from 'node:test';
import assert from 'node:assert/strict';
import * as A from '../src/agents/approvals.js';

test('denying a finished run cannot affect another message approval', () => {
  const a=A.createApproval({threadId:'fixture-chat',messageId:'first',agent:'claude',toolName:'Bash',input:{command:'npm test'}});
  const b=A.createApproval({threadId:'fixture-chat',messageId:'second',agent:'claude',toolName:'Write',input:{file_path:'demo.txt'}});
  A.denyForMessage('first');
  assert.equal(A.getApproval(a.id).status,'denied'); assert.equal(A.getApproval(b.id).status,'pending');
  A.decide(b.id,'allowed'); assert.equal(A.getApproval(b.id).status,'allowed');
  A.decide(b.id,'denied'); assert.equal(A.getApproval(b.id).status,'allowed');
});
test('remembered tool approval applies only to that tool', () => {
  const allowed=A.createApproval({threadId:'fixture-chat',messageId:'third',agent:'claude',toolName:'Write',input:{}},['Write']);
  const pending=A.createApproval({threadId:'fixture-chat',messageId:'fourth',agent:'claude',toolName:'Bash',input:{}},['Write']);
  assert.equal(allowed.status,'allowed'); assert.equal(pending.status,'pending'); A.denyForMessage('fourth');
});
