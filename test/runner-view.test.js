import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeRunnerLogs} from '../public/views/runner.js';

test('Runner reconnect snapshots preserve earlier output and merge missed lines once in sequence',()=>{
  const line=(seq,text)=>({seq,text,stream:'stdout'});
  const existing=[line(1,'before')],replay=[line(2,'while connecting'),line(3,'done')];
  const combined=mergeRunnerLogs(existing,replay);
  assert.deepEqual(combined.map(x=>x.text),['before','while connecting','done']);
  assert.deepEqual(mergeRunnerLogs(combined,[line(3,'done'),line(2,'while connecting')]),combined);
  assert.deepEqual(mergeRunnerLogs(combined,[]),combined);
});
