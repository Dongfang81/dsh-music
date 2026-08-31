import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
function setup(load) {
  const c = {
    favoritesLoadRef: { current: 0 }, favoriteRevision: null, favoritesOpen: true,
    state: { instanceId: 'boot', favorites: { revision: 1 } },
    favoritesApi: load,
    collectionVersion: (id, rev) => `${id}:${rev}`,
    shouldReloadCollection: (a,b,open) => open && a !== b,
    setFavoriteSongs(value) { c.songs = value; },
    setFavoriteRevision(value) { c.favoriteRevision = value; },
    setFavoritesLoading(value) { c.loading = value; },
    setFavoriteLoadError(value) { c.error = value; },
    flash() {}, React: { useEffect(fn) { c.effect = fn; } }
  };
  const start = source.indexOf('var loadFavorites = function');
  vm.runInNewContext(source.slice(start, source.indexOf('var toggleFavorites = function', start)), c);
  return c;
}
const good = { ok: true, instanceId: 'boot', revision: 1, songs: [{id:1,name:'Moon'}] };
test('favorites read aborts a stalled connection so the retry UI can appear', async()=>{
  const timers=[];
  const c={AbortController,setTimeout(fn){timers.push(fn);return 1;},clearTimeout(){},
    fetch(_url,options){return new Promise((resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(options.signal.reason)));}
  };
  const helper=source.slice(source.indexOf('function fetchJsonWithTimeout('),source.indexOf('function compactStateSignature('));
  const post=source.slice(source.indexOf('function post('),source.indexOf('var command ='));
  const api=source.slice(source.indexOf('var favoritesApi ='),source.indexOf('var removeFavoriteApi ='));
  vm.runInNewContext(helper+post+api,c);
  const pending=c.favoritesApi();
  assert.equal(timers.length,1,'stalled favorites reads need an abort deadline');
  timers[0](); await assert.rejects(pending,/request timeout/);
});
test('favorites failure ends loading with an error and manual retry works at the same revision', async () => {
  let fail = true;
  const c = setup(async()=>{ if(fail) throw new Error('offline'); return good; });
  await assert.rejects(c.loadFavorites('boot:1'));
  assert.equal(c.loading, false); assert.equal(c.error?.version, 'boot:1');
  fail = false; await c.loadFavorites('boot:1');
  assert.equal(c.error, null); assert.deepEqual(c.songs, good.songs);
  assert.equal(c.favoriteRevision, 'boot:1');
});
for (const [name, payload] of [['stale version',{...good,revision:0}], ['malformed songs',{...good,songs:{}}]]) {
  test(`favorites ${name} becomes retryable failure, not perpetual loading`, async()=>{
    const c = setup(async()=>payload);
    await assert.rejects(c.loadFavorites('boot:1'));
    assert.equal(c.loading,false); assert.equal(c.error?.version,'boot:1');
  });
}
test('late failure from an obsolete favorites request cannot replace a newer result', async()=>{
  let reject, count=0;
  const c = setup(()=>++count===1 ? new Promise((_,no)=>reject=no) : Promise.resolve(good));
  const old = c.loadFavorites('boot:1').catch(()=>{});
  await c.loadFavorites('boot:1'); reject(new Error('old')); await old;
  assert.equal(c.error,null); assert.deepEqual(c.songs,good.songs);
});
test('failed favorites panel displays known count and retry rather than loading or empty state',()=>{
  let definition, retries=0;
  const React={ createElement(type,props,...children){return {type,props:{...props,children}};}, useState(v){return [v,()=>{}];} };
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load(d){definition=d;}}}});
  const client=definition.factory(n=>n==='react'?React:{});
  const tree=client.FavoriteListPanel({songs:[],count:29,loading:true,error:true,onRetry(){retries++;}});
  function nodes(t){return Array.isArray(t)?t.flatMap(nodes):t&&typeof t==='object'?[t,...nodes(t.props?.children)]:[];}
  const all=nodes(tree), retry=all.find(n=>n.props?.['aria-label']==='重新加载收藏列表');
  assert.ok(retry); retry.props.onClick(); assert.equal(retries,1);
  assert.ok(all.some(n=>n.props?.children?.includes('29 首')));
  assert.equal(all.some(n=>n.props?.children?.includes('正在读取收藏…')),false);
});
