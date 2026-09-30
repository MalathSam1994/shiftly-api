const express=require('express');
const {sendApiError}=require('../utils/apiError');
const {sendPostgresError}=require('../utils/postgresErrorMapper');
const requirePermission=require('../middleware/requirePermission');
const registry=require('../reports/clinicalHandover/registry');
const reports=require('../reports/clinicalHandover/service');
const {excel}=require('../reports/clinicalHandover/excel');
const router=express.Router();
router.use(requirePermission(registry.OPEN));
router.use((req,res,next)=>{res.set('Cache-Control','no-store');next();});
const actor=req=>Number(req.user?.sub??req.user?.id);
const wrap=handler=>async(req,res)=>{try{await handler(req,res);}catch(e){
  if(e.constraint==='handover_report_dataset_size') return sendApiError(req,res,{status:413,error:'This report exceeds the 10 MB storage limit. Narrow the scope.',code:'REPORT_TOO_LARGE'});
  if(e.code==='22023') return sendApiError(req,res,{status:400,error:e.message,code:'REPORT_VALIDATION'});
  if(e.status) return sendApiError(req,res,{status:e.status,error:e.message,code:e.code});
  return sendPostgresError(req,res,e,{action:'GET',label:'Clinical Handover report unavailable'});
}};
function allow(input,keys) {for(const key of Object.keys(input||{}))if(!keys.includes(key))throw registry.fail(`Unsupported input: ${key}.`);}
function integer(v,fallback,max) {if(v==null)return fallback;if(!/^\d+$/.test(String(v))||Number(v)>max)throw registry.fail('Invalid page size or offset.');return Number(v);}
function generationId(req) {if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(req.params.id))throw registry.fail('Invalid report generation.');return req.params.id;}
router.get('/catalog',wrap(async(req,res)=>{allow(req.query,[]);res.json(await reports.catalog(actor(req)));}));
router.get('/lookups/:field',wrap(async(req,res)=>{
  allow(req.query,['reportId','parameters','search','offset']);
  let params;try{params=JSON.parse(req.query.parameters||'{}');}catch(_){throw registry.fail('Invalid lookup parameters.');}
  if(req.query.search!=null&&(typeof req.query.search!=='string'||req.query.search.length>120))throw registry.fail('Use a search of at most 120 characters.');
  res.json(await reports.lookups(actor(req),req.query.reportId,req.params.field,params,req.query.search||'',integer(req.query.offset,0,10000)));
}));
router.post('/generations',wrap(async(req,res)=>{
  allow(req.query,[]);allow(req.body,['reportId','parameters']);
  res.status(201).json(await reports.generate(actor(req),req.body?.reportId,req.body?.parameters||{}));
}));
router.get('/generations/:id',wrap(async(req,res)=>{
  allow(req.query,['section','offset','limit']);
  const data=await reports.retrieve(actor(req),generationId(req));
  const limit=integer(req.query.limit,100,100);if(limit<1)throw registry.fail('Page size must be positive.');
  res.json(reports.preview(data,req.query.section,integer(req.query.offset,0,5000),limit));
}));
// Complete read-authorized dataset for the embedded PDF; downloads still require
// the separate export permission through /export/:format. No report re-evaluation.
router.get('/generations/:id/preview/pdf',wrap(async(req,res)=>{
  allow(req.query,[]);
  res.json(reports.exportData(await reports.retrieve(actor(req),generationId(req))));
}));
router.get('/generations/:id/findings/:finding/target',wrap(async(req,res)=>{
  allow(req.query,[]);if(typeof req.params.finding!=='string'||req.params.finding.length>180)throw registry.fail('Invalid finding reference.');
  res.json(await reports.readinessTarget(actor(req),generationId(req),req.params.finding));
}));
router.get('/generations/:id/issues/:issue/target',wrap(async(req,res)=>{
  allow(req.query,[]);if(!/^[1-9][0-9]{0,18}$/.test(req.params.issue))throw registry.fail('Invalid canonical issue reference.');
  res.json(await reports.outstandingTarget(actor(req),generationId(req),req.params.issue));
}));
router.get('/generations/:id/export/:format',wrap(async(req,res)=>{
  allow(req.query,[]);if(!['pdf','excel'].includes(req.params.format))throw registry.fail('Choose PDF or Excel.');
  const data=reports.exportData(await reports.retrieve(actor(req),generationId(req),true));
  if(req.params.format==='pdf')return res.json(data); // Authorized complete dataset for report-owned Flutter PDF renderer.
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition',`attachment; filename="clinical-handover-${data.reportId}-${data.generatedAt.slice(0,10)}.xlsx"`);
  res.send(Buffer.from(await excel(data)));
}));
module.exports=router;
