const assert = require('node:assert/strict');
const test = require('node:test');
const dbPath = require.resolve('../db');
const fakePool = {query: async () => {throw new Error('Unexpected query');}};
require.cache[dbPath] = {id: dbPath, filename: dbPath, loaded: true, exports: fakePool};
const router = require('../routes/clinical');
const token = 'a'.repeat(32);
const request = () => ({user: {sub: '271'}, params: {id: '4'}, body: {source_rule_set_id: 3, mode: 'add_missing', preview_token: token, actor: 999}, rid: 'import-test'});
const response = () => ({statusCode: 200, status(code) {this.statusCode=code;return this;}, set() {return this;}, json(body) {this.body=body;return this;}});
const routeFor = (kind, apply) => router.stack.find(layer => layer.route?.path === '/acuity/rule-sets/:id/import-' + kind + (apply ? '' : '/preview')).route;
for (const [kind, screen] of Object.entries({levels: 'clinical_acuity_levels', factors: 'clinical_acuity_factors', flow: 'clinical_flow_workload_rules'})) {
  for (const apply of [false, true]) {
    const route=routeFor(kind,apply);
    test(kind + (apply ? ' apply' : ' preview') + ' requires screen and manage permissions', async () => {
      for (const [index,key] of ['screen:' + screen + ':open','action:clinical_acuity_rules:manage'].entries()) {
        fakePool.query=async (sql,values)=>{assert.deepEqual(values,[271,key]);return {rows:[{ok:false}]};};
        const res=response();await route.stack[index].handle(request(),res,()=>assert.fail('Denied request continued'));
        assert.equal(res.statusCode,403);
      }
    });
    test(kind + (apply ? ' apply' : ' preview') + ' uses authenticated actor and server-controlled mode of execution', async () => {
      fakePool.query=async (sql,values)=>{
        assert.match(sql,/fn_clinical_import_rule_configuration/);
        assert.deepEqual(values,[4,3,271,kind,'add_missing',apply,apply?token:null]);
        return {rows:[{result:{applied:apply,can_apply:true,token}}]};
      };
      const res=response();await route.stack.at(-1).handle(request(),res);
      assert.equal(res.statusCode,200);assert.equal(res.body.applied,apply);
    });
  }
}
test('apply requires valid IDs, supported mode and a preview token', async () => {
  const handler=routeFor('levels',true).stack.at(-1).handle;
  fakePool.query=async()=>assert.fail('Invalid input reached database');
  for (const overrides of [
    {params:{id:'0'}},{params:{id:'4abc'}},
    {body:{source_rule_set_id:4,mode:'replace_all',preview_token:token}},
    {body:{source_rule_set_id:3,mode:'unknown',preview_token:token}},
    {body:{source_rule_set_id:3,mode:'replace_all'}},
    {body:{source_rule_set_id:3,mode:'replace_all',preview_token:'invalid'}},
  ]) {
    const res=response();await handler({...request(),...overrides},res);assert.equal(res.statusCode,400);
  }
});
for (const [hint,status] of [['CLINICAL_IMPORT_STALE',409],['CLINICAL_IMPORT_UNAVAILABLE',404],['CLINICAL_IMPORT_DRAFT_REQUIRED',409],['CLINICAL_IMPORT_CONFLICT',422]]) {
  test('safe import error ' + hint,async()=>{
    fakePool.query=async()=>{throw Object.assign(new Error('Private SQL details'),{code:'P0001',hint});};
    const res=response();await routeFor('levels',true).stack.at(-1).handle(request(),res);
    assert.equal(res.statusCode,status);assert.equal(res.body.code,hint);assert.doesNotMatch(JSON.stringify(res.body),/Private SQL/);
  });
}
