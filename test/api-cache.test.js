import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, clearApiCache } from '../public/lib.js';

const response = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
function setup(t) {
  clearApiCache();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (url, options) => new Promise((resolve, reject) => calls.push({ url, options, resolve: data => resolve(response(data)), reject }));
  t.after(() => { globalThis.fetch = original; clearApiCache(); });
  return calls;
}

test('deduplicates GETs, isolates cancellation and returned data', async t => {
  const calls = setup(t), ctrl = new AbortController();
  const first = api('/dedup', { signal: ctrl.signal, cache: 1000 });
  const cancelled = assert.rejects(first, { name: 'AbortError' });
  const second = api('/dedup', { cache: 1000 });
  ctrl.abort();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.signal.aborted, false);
  calls[0].resolve({ nested: { value: 1 } });
  await cancelled;
  const data = await second;
  data.nested.value = 99;
  assert.equal((await api('/dedup', { cache: 1000 })).nested.value, 1);
});

test('immediate revisit replaces aborted fetch without old cleanup deleting it', async t => {
  const calls = setup(t), ctrl = new AbortController();
  const old = api('/revisit', { signal: ctrl.signal });
  const cancelled = assert.rejects(old, { name: 'AbortError' });
  ctrl.abort();
  const fresh = api('/revisit');
  assert.equal(calls.length, 2);
  calls[0].reject(new DOMException('Aborted', 'AbortError'));
  await cancelled;
  await new Promise(resolve => setImmediate(resolve));
  const joined = api('/revisit');
  assert.equal(calls.length, 2);
  calls[1].resolve({ current: true });
  assert.deepEqual(await fresh, await joined);
});

test('mutation prevents reuse and caching of pre-mutation snapshots', async t => {
  const calls = setup(t);
  const stale = api('/state', { cache: 1000 });
  const mutation = api('/state', { method: 'POST', body: { value: 2 } });
  calls[1].resolve({ ok: true });
  await mutation;
  const fresh = api('/state', { cache: 1000 });
  assert.equal(calls.length, 3);
  calls[2].resolve({ value: 2 });
  await fresh;
  calls[0].resolve({ value: 1 });
  await stale;
  assert.deepEqual(await api('/state', { cache: 1000 }), { value: 2 });
});

test('deduplicated callers receive independent objects and detach abort listeners', async t => {
  const calls = setup(t), ctrl = new AbortController();
  let added = 0, removed = 0;
  const add = ctrl.signal.addEventListener.bind(ctrl.signal);
  const remove = ctrl.signal.removeEventListener.bind(ctrl.signal);
  ctrl.signal.addEventListener = (...args) => { added++; return add(...args); };
  ctrl.signal.removeEventListener = (...args) => { removed++; return remove(...args); };
  const first = api('/copies', { signal: ctrl.signal });
  const second = api('/copies');
  calls[0].resolve({ list: [1] });
  const a = await first, b = await second;
  a.list.push(2);
  assert.deepEqual(b.list, [1]);
  assert.equal(added, removed);
});
