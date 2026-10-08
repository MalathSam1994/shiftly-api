const { randomUUID, createHash } = require('node:crypto');
const pool = require('../../db');
const { setLocalBusinessTimezone } = require('../../utils/shiftlyRuntimeConfig');
const registry = require('./registry');
// Report-specific, read-only PostgreSQL dataset readers for all seven reports.
// Enabling metadata alone cannot accidentally enable an empty or fake report.
const patientSheet=require('./patientSheet');
const shiftChanges=require('./shiftChanges');
const readiness=require('./readiness');
const outstandingIssues=require('./outstandingIssues');
const workload=require('./workload');
const reviewFollowUp=require('./reviewFollowUp');
const readers = new Map([['unit_handover_summary',require('./unitSummary').read],['patient_handover_sheet',patientSheet.read],['changes_since_previous_shift',shiftChanges.read],['incoming_shift_readiness',readiness.read],['outstanding_handover_issues',outstandingIssues.read],['workload_and_continuity',workload.read],['handover_review_follow_up',reviewFollowUp.read]]);
const MAX_ROWS = 5000, MAX_BYTES = 10 * 1024 * 1024;
async function transaction(readOnly, action) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await setLocalBusinessTimezone(client);
    await client.query("SET LOCAL statement_timeout = '20s'");
    const value = await action(client);
    await client.query('COMMIT');
    return value;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
async function permissions(client, actor, keys) {
  const { rows } = await client.query('SELECT k,shiftly_api.fn_user_has_permission($1,k::varchar) allowed FROM unnest($2::text[]) k', [actor, keys]);
  return Object.fromEntries(rows.map(r => [r.k, r.allowed]));
}
async function authorize(client, actor, def, exporting = false) {
  const keys = [...def.access, ...(exporting ? [registry.EXPORT] : [])];
  const granted = await permissions(client, actor, keys);
  if (keys.some(k => !granted[k])) throw registry.fail('Your current report data/export permissions do not allow this request.',403,'REPORT_FORBIDDEN');
}
async function scope(client, actor, params) {
  const { rows } = await client.query('SELECT shiftly_api.fn_handover_report_scope($1,$2::jsonb) value',[actor,params]);
  return rows[0].value;
}
async function lookup(client, actor, kind, params, search = '', offset = 0, value = null) {
  const { rows } = await client.query('SELECT shiftly_api.fn_handover_report_lookups($1,$2,$3::jsonb,$4,$5,$6) value',[actor,kind,params,search,offset,value]);
  return rows[0].value;
}
async function selectionLookup(client,actor,def,key,params,search='',offset=0,value=null) {
  if (['shiftTypeId','shiftContextId','incomingContextId','outgoingContextId'].includes(key)) {
    const {rows}=await client.query('SELECT shiftly_api.fn_handover_report_shift_lookup($1,$2,$3::jsonb,$4,$5,$6) value',
      [actor,key,params,search,offset,value]);
    return rows[0].value;
  }
  return lookup(client,actor,registry.fields[key].lookup,params,search,offset,value);
}
async function resolveSelections(client, actor, def, params) {
  const result = {};
  for (const key of def.parameters) {
    const f = registry.fields[key];
    if (f.type !== 'lookup' || params[key] == null) continue;
    const choices=[];
    if (f.multiple && def.id==='patient_handover_sheet') {
      const page=await selectionLookup(client,actor,def,key,params,'',0,JSON.stringify(params[key]));
      const byId=new Map(page.rows.map(c=>[c.value,c]));
      if (params[key].some(v=>!byId.has(v))) throw registry.fail(`${f.label} changed at this boundary/scope. Choose the encounters again.`,409,'REPORT_SELECTION_CHANGED');
      choices.push(...params[key].map(v=>byId.get(v)));
    } else for (const value of [params[key]]) {
      const page=await selectionLookup(client,actor,def,key,params,'',0,String(value));
      if (page.rows.length!==1) throw registry.fail(`${f.label} is no longer available at this boundary/scope. Choose it again.`,409,'REPORT_SELECTION_CHANGED');
      choices.push(page.rows[0]);
    }
    result[key]=f.multiple?{value:params[key],label:choices.map(c=>c.label).join('; '),meta:{choices}}:choices[0];
    if (['shiftContextId','incomingContextId','targetContextKey'].includes(key) && result[key].meta.shiftDate !== params.shiftDate) throw registry.fail('Choose a context on the selected shift date.');
  }
  if (result.outgoingContextId && result.incomingContextId &&
      result.incomingContextId.meta.start_at <= result.outgoingContextId.meta.start_at) {
    throw registry.fail('The incoming shift must start after the outgoing shift.');
  }
  return result;
}
async function catalog(actor) {
  return transaction(true, async client => {
    const context = await scope(client,actor,{});
    const keys = [...new Set([registry.EXPORT,...registry.reports.flatMap(r=>r.access),...Object.values(registry.fields).flatMap(f=>f.access||[])])];
    const granted = await permissions(client,actor,keys);
    return { schemaVersion:1, scopeSignature:createHash('sha256').update(JSON.stringify(context.pairs.map(p=>[p.division_id,p.department_id]))).digest('hex'), fields:registry.fields, permissions:granted,
      businessTimezone:context.business_timezone,businessToday:context.business_today,serverTime:context.reference_time,
      reports:registry.reports.map(r=>({...r,available:r.available&&readers.has(r.id),authorized:r.access.every(k=>granted[k])})),
      limits:{ inclusiveDays:31,rows:MAX_ROWS,previewPage:100,generationMinutes:30,activeGenerationsPerUser:5 } };
  });
}
async function lookups(actor, id, field, params, search, offset) {
  const def=registry.report(id), f=registry.fields[field];
  if (!def.parameters.includes(field) || !f || f.type!=='lookup') throw registry.fail('This selector is not supported by this report.');
  params=registry.parameters(def,params,{partial:true});
  return transaction(true,async client=>{
    if (['patient_handover_sheet','changes_since_previous_shift','incoming_shift_readiness','outstanding_handover_issues','workload_and_continuity','handover_review_follow_up'].includes(def.id)) await authorize(client,actor,def);
    return selectionLookup(client,actor,def,field,params,search,offset);
  });
}
function validateDataset(def, result) {
  if (!result || typeof result!=='object' || !Array.isArray(result.sections) || !Array.isArray(result.summaries) ||
      !Array.isArray(result.metricDefinitions) || !Array.isArray(result.sourceLimitations) || !result.rowGrain || !result.totals) {
    throw registry.fail('The report reader did not provide a complete result contract.',500,'REPORT_CONTRACT');
  }
  for (const m of result.summaries) {
    if (!m || typeof m.label!=='string' || typeof m.definition!=='string' || !['AVAILABLE','UNAVAILABLE'].includes(m.availability) ||
        (m.value!==null && (typeof m.value!=='number' || !Number.isFinite(m.value))) ||
        (m.availability==='UNAVAILABLE' && m.value!==null)) throw registry.fail('Summary values need explicit definitions and availability.',500,'REPORT_CONTRACT');
  }
  let count=0; const ids=new Set();
  for (const s of result.sections) {
    if (!s.grain || !['HISTORICAL','CURRENT','PLAN','MIXED'].includes(s.evidenceBasis) || !def.sections.some(d=>d.id===s.id) || ids.has(s.id) || !Array.isArray(s.rows) || !Array.isArray(s.columns) || !Array.isArray(s.limitations) ||
        !['AVAILABLE','UNAVAILABLE'].includes(s.availability) || s.total!==s.rows.length ||
        (s.rows.length && !s.columns.length) ||
        (s.availability==='UNAVAILABLE' && (s.rows.length || !s.limitations.length))) throw registry.fail('A report section is incomplete; nothing was saved.',500,'REPORT_CONTRACT');
    ids.add(s.id); count+=s.rows.length;
    if (!s.rows.every(r=>r && typeof r==='object' && !Array.isArray(r))) throw registry.fail('Invalid report rows.',500,'REPORT_CONTRACT');
    const columnIds=new Set();
    for (const col of s.columns) {
      if (!col.key || !col.label || columnIds.has(col.key) || !['text','identifier','number','date','datetime','status'].includes(col.type)) throw registry.fail('Invalid report column contract.',500,'REPORT_CONTRACT');
      columnIds.add(col.key);
      if (typeof col.label !== 'string') throw registry.fail('Invalid report column label.',500,'REPORT_CONTRACT');
    }
    for (const row of s.rows) for (const col of s.columns) {
      const value=row[col.key];
      if (value==null) continue;
      if (col.type==='number' ? typeof value!=='number'||!Number.isFinite(value) : typeof value!=='string') throw registry.fail('Invalid typed report value.',500,'REPORT_CONTRACT');
      if (typeof value==='string' && value.length>32000) throw registry.fail('A report cell exceeds the supported export length. Narrow the detail.',413,'REPORT_TOO_LARGE');
      if (col.type==='date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value+'T00:00:00Z')) || new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)) throw registry.fail('Invalid report date.',500,'REPORT_CONTRACT');
      if (col.type==='datetime' && (!/(Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))) throw registry.fail('Report timestamps require explicit offsets.',500,'REPORT_CONTRACT');
    }
  }
  if (def.sections.some(s=>!ids.has(s.id))) throw registry.fail('Every declared section must return data or an explicit limitation.',500,'REPORT_CONTRACT');
  if (count>MAX_ROWS) throw registry.fail('This report exceeds 5,000 rows. Narrow the dates or unit; exports are never silently truncated.',413,'REPORT_TOO_LARGE');
  return count;
}
async function generate(actor,id,input) {
  const def=registry.report(id), params=registry.parameters(def,input);
  const dataset=await transaction(true,async client=>{
    await authorize(client,actor,def);
    const ctx=await scope(client,actor,params);
    if (!def.available||!readers.has(id)) throw registry.fail(def.unavailableReason,409,'REPORT_NOT_IMPLEMENTED');
    const dataReferenceTime=ctx.reference_time;
    const selections=await resolveSelections(client,actor,def,ctx.parameters);
    let referenceTime=params.referenceTime||ctx.reference_time;
    const boundary=selections.shiftContextId||selections.incomingContextId||selections.targetContextKey;
    if (!params.referenceTime && boundary) {
      const {rows}=await client.query('SELECT $1::timestamp AT TIME ZONE $2::text AS instant',[boundary.meta.start_at,ctx.business_timezone]);
      referenceTime=rows[0].instant.toISOString();
    }
    if (def.parameters.includes('referenceTime')) ctx.parameters.referenceTime=referenceTime;
    ctx.reference_time=referenceTime; ctx.data_reference_time=dataReferenceTime;
    // Reader gets one read-only repeatable-read transaction and normalized scope.
    // It must return complete sections, never capped preview aggregates.
    const {authorizationPairs=[],...result}=await readers.get(id)(client,{actor,parameters:ctx.parameters,scope:ctx,selections});
    // Transfer counterparts can expose authorized evidence outside the selected
    // filter. Capture those pairs too, so later scope loss also blocks retrieval.
    const capturedPairs=new Map(ctx.pairs.map(p=>[`${p.division_id}:${p.department_id}`,p]));
    for (const pair of authorizationPairs) capturedPairs.set(`${pair.division_id}:${pair.department_id}`,pair);
    const authorizedScope={...ctx,pairs:[...capturedPairs.values()]};
    const rowCount=validateDataset(def,result);
    return {...result,reportId:id,title:def.title,schemaVersion:1,parameters:ctx.parameters,selections,
      authorizedScope,scopeLabel:[ctx.unit_name,...ctx.pairs.map(p=>`${p.department_name} | ${p.division_name}`)].filter(Boolean).join(' / '),
      businessTimezone:ctx.business_timezone,referenceTime:result.changeContext?.reference||result.patientContext?.reference||result.unitContext?.reference||result.reviewContext?.reference||result.workloadContext?.reference||result.issueContext?.reference||result.readinessContext?.reference||referenceTime,dataReferenceTime,timeBasis:def.timeBasis,
      generatedAt:dataReferenceTime,intervalStart:result.reviewContext?.start||result.workloadContext?.start||result.issueContext?.start||result.patientContext?.start||result.unitContext?.start||result.readinessContext?.start||result.changeContext?.start||ctx.interval_start,intervalEndExclusive:result.reviewContext?.endExclusive||result.workloadContext?.endExclusive||result.issueContext?.endExclusive||result.patientContext?.endExclusive||result.unitContext?.endExclusive||result.readinessContext?.endExclusive||result.readinessContext?.end||result.changeContext?.endExclusive||ctx.interval_end_exclusive,
      planningBasis:result.reviewContext?.version===4?'Expected shifts on the selected date, retained schedules and latest published patient assignments. Future dates use current patients.':result.reviewContext?.version===3?'Published assignment changes during the selected date; before and after belong to the same recorded publication.':result.reviewContext?.version===2?'Recorded review activity for the selected shift date, by day end or generation time today.':result.workloadContext?.version===2?'Shifts starting on the selected date, observed by shift end or report time. Today excludes shifts not yet started.':result.issueContext?.version===2?'Recorded outstanding issues at the end of the selected date; today uses the latest recorded state.':result.readinessContext?.version===2?'All shifts starting on the selected date; past dates show retained schedules, current and future dates show the recorded plan.':result.changeContext?.version===2?'Changes during the selected date; today includes recorded changes so far.':(result.unitContext||result.patientContext?.version===2)?'End of the selected date; today includes recorded data so far.':'Future contexts describe the current recorded plan, not confirmed future outcomes. Expected discharge is not actual discharge.',rowCount};
  });
  if (Buffer.byteLength(JSON.stringify(dataset),'utf8')>MAX_BYTES) throw registry.fail('Report exceeds the 10 MB generation limit. Narrow the scope.',413,'REPORT_TOO_LARGE');
  return transaction(false,async client=>{
    await authorize(client,actor,def);
    await recheckScope(client,actor,dataset.authorizedScope);
    await client.query('SELECT pg_advisory_xact_lock(270927,$1)',[actor]);
    // Bounded report-only cache. Clinical data and other users' read history are untouched.
    await client.query('DELETE FROM shiftly_schema.clinical_handover_report_generations WHERE expires_at<=now()');
    await client.query(`DELETE FROM shiftly_schema.clinical_handover_report_generations WHERE actor_id=$1 AND id IN
      (SELECT id FROM shiftly_schema.clinical_handover_report_generations WHERE actor_id=$1 ORDER BY created_at DESC,id DESC OFFSET 4)`,[actor]);
    const id=randomUUID();
    const {rows}=await client.query(`INSERT INTO shiftly_schema.clinical_handover_report_generations(id,actor_id,report_id,authorized_scope,dataset)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb) RETURNING expires_at`,[id,actor,def.id,dataset.authorizedScope,dataset]);
    return preview({...dataset,generationId:id,expiresAt:rows[0].expires_at},null,0,100);
  });
}
async function recheckScope(client,actor,saved) {
  await scope(client,actor,saved.parameters);
  // pg encodes bare JS arrays as PostgreSQL arrays; this parameter must be JSON.
  // Keep the complete captured scope and the database authorization predicate.
  const {rows}=await client.query(`SELECT bool_and(shiftly_api.fn_user_can_access_division_department($1,
    (x->>'division_id')::integer,(x->>'department_id')::integer)) ok FROM jsonb_array_elements($2::jsonb) x`,[actor,JSON.stringify(saved.pairs)]);
  if (rows[0].ok!==true) throw registry.fail('Your access to this generated report has changed. Generate a new report for your current scope.',403,'REPORT_SCOPE_CHANGED');
}
async function retrieve(actor,id,exporting=false) {
  return transaction(true,async client=>{
    const {rows}=await client.query(`SELECT *,expires_at<=now() expired FROM shiftly_schema.clinical_handover_report_generations WHERE id=$1 AND actor_id=$2`,[id,actor]);
    if (!rows.length||rows[0].expired) throw registry.fail('This report has expired or is unavailable. Generate it again.',410,'REPORT_EXPIRED');
    const saved=rows[0];
    await authorize(client,actor,registry.report(saved.report_id),exporting);
    await recheckScope(client,actor,saved.authorized_scope);
    registry.assertClinicalPresentation(saved.dataset,saved.report_id,true);
    return {...saved.dataset,generationId:id,expiresAt:saved.expires_at};
  });
}
function preview(dataset,sectionId,offset,limit) {
  registry.assertClinicalPresentation(dataset,dataset.reportId,true);
  const id=sectionId||dataset.sections[0]?.id;
  if (id&&!dataset.sections.some(s=>s.id===id)) throw registry.fail('Choose an available report section.');
  const {authorizedScope,...publicData}=dataset;
  const patientDetails=dataset.reportId==='patient_handover_sheet' && id==='patients' ? patientSheet.pageDetails(dataset,offset,limit) : undefined;
  const changeDetails=dataset.reportId==='changes_since_previous_shift' && dataset.changeContext?.version!==2 && id==='changes' ? shiftChanges.pageDetails(dataset,offset,limit) : undefined;
  const issueDetails=dataset.reportId==='outstanding_handover_issues' && dataset.issueContext?.version!==2 && id==='issues' ? outstandingIssues.pageDetails(dataset,offset,limit) : undefined;
  const reviewDetails=dataset.reportId==='handover_review_follow_up' && ![2,3,4].includes(dataset.reviewContext?.version) && id==='reviews' ? reviewFollowUp.pageDetails(dataset,offset,limit) : undefined;
  return {...publicData,...(reviewDetails?{reviewDetails}:{}),...(issueDetails?{issueDetails}:{}),...(patientDetails?{patientDetails}:{}),...(changeDetails?{changeDetails}:{}),sections:dataset.sections.map(s=>({...s,rows:s.id===id?s.rows.slice(offset,offset+limit):[]})),
    page:{sectionId:id,offset,limit,total:dataset.sections.find(s=>s.id===id)?.total||0}};
}
// Resolve only a saved report finding. No client-supplied destinations or IDs;
// recheck current scope, source identity and actual interval before navigation.
async function readinessTarget(actor,id,key) {
 const data=await retrieve(actor,id);
 if(data.reportId!=='incoming_shift_readiness') throw registry.fail('This report has no readiness actions.');
 const finding=data.sections.find(s=>s.id==='findings')?.rows.find(r=>r.key===key);
 const permission={BOARD:'screen:clinical_assignment_board:open',STAFF_POOL:'screen:clinical_staff_pool:open',SHIFTS:'screen:shift_periods:open'}[finding?.destination];
 if(!finding||!permission) throw registry.fail('Use the saved finding details; there is no supported context action.',409,'REPORT_TARGET_UNAVAILABLE');
 return transaction(true,async client=>{
  await authorize(client,actor,registry.report(data.reportId));await recheckScope(client,actor,data.authorizedScope);
  const granted=await permissions(client,actor,[permission]);if(!granted[permission]) throw registry.fail('Your current access does not allow this destination.',403,'REPORT_FORBIDDEN');
  const saved=data.readinessContext;
  const {rows}=await client.query(`SELECT * FROM shiftly_api.fn_handover_readiness_contexts($1,$2::jsonb)
    WHERE context_key=$3 AND start_at=$4::timestamp AND end_at=$5::timestamp AND period_id=$6`,
   [actor,data.parameters,saved.contextKey,saved.startLocal,saved.endLocal,saved.periodId]);
  if(rows.length!==1) throw registry.fail('The shift ended, changed or was removed. Its saved evidence remains in this report; choose a new context explicitly.',409,'REPORT_TARGET_UNAVAILABLE');
  const current=rows[0];
  const {rows:valid}=await client.query(`SELECT
   ($1::integer IS NULL OR EXISTS(SELECT 1 FROM shiftly_schema.shift_assignments a WHERE a.id=$1 AND a.user_id=$2 AND a.shift_period_id=$3
     AND a.shift_date=$4 AND a.shift_type_id=$5 AND a.department_id=$7 AND COALESCE(a.division_id,$6)=$6 AND a.status<>'CANCELLED')) staff,
   ($8::integer IS NULL OR EXISTS(SELECT 1 FROM shiftly_schema.clinical_encounters e WHERE e.id=$8 AND e.current_clinical_unit_id=$9 AND e.division_id=$6 AND e.department_id=$7)) patient,
   ($10::integer IS NULL OR EXISTS(SELECT 1 FROM shiftly_schema.clinical_assignment_review_workflows w WHERE w.id=$10 AND w.shift_date=$4 AND w.shift_type_id=$5
     AND w.division_id=$6 AND w.department_id=$7 AND (w.clinical_unit_id IS NULL OR w.clinical_unit_id=$9))) workflow,
   ($11::integer IS NULL OR EXISTS(SELECT 1 FROM shiftly_schema.clinical_assignment_optimization_runs r WHERE r.id=$11 AND r.shift_date=$4 AND r.shift_type_id=$5
     AND r.division_id=$6 AND r.department_id=$7 AND (r.clinical_unit_id IS NULL OR r.clinical_unit_id=$9))) run`,
   [finding.assignmentId,data.sections.find(s=>s.id==='staff').rows.find(r=>r.assignmentId===finding.assignmentId)?.userId||null,
    saved.periodId,saved.shiftDate,saved.shiftTypeId,saved.divisionId,saved.departmentId,finding.encounterId,saved.unitId,finding.workflowId,finding.runId]);
  if(Object.values(valid[0]).some(v=>!v)) throw registry.fail('An affected record moved, changed or is no longer accessible. The saved finding remains available in this report.',409,'REPORT_TARGET_UNAVAILABLE');
  if(finding.destination==='BOARD' && Number(current.approved_rows)===0) throw registry.fail('There is no approved working roster in this context yet. Open Shift Periods from the staffing finding first, then return to the Assignment Board.',409,'REPORT_TARGET_UNAVAILABLE');
  return {destination:finding.destination,assignmentId:finding.assignmentId,periodId:saved.periodId,
   note:'Opens the current operational context. This report remains a saved generation; opening does not resolve its findings.',
   scope:{division_id:saved.divisionId,department_id:saved.departmentId,clinical_unit_id:saved.unitId,clinical_unit_name:saved.unit,
    shift_date:saved.shiftDate,shift_type_id:saved.shiftTypeId,shift_label:saved.shift,start_time:saved.startLocal.slice(11),end_time:saved.endLocal.slice(11),
    workflow_id:finding.workflowId,run_id:finding.runId}};
 });
}
// This endpoint reads a saved issue and current identity/permission only. It never
// calls the operational Attention API (which may reconcile on other routes).
async function outstandingTarget(actor,id,issueId) {
 const data=await retrieve(actor,id);
 if(data.reportId!=='outstanding_handover_issues') throw registry.fail('This generation has no outstanding-issue targets.');
 if(data.issueContext?.version===2) throw registry.fail('This daily summary has no direct issue actions. Open the relevant operational screen to review an issue.',409,'REPORT_TARGET_UNAVAILABLE');
 const row=data.sections.find(s=>s.id==='issues').rows.find(r=>r.issueId===issueId);
 if(!row||row.actionAvailable!=='YES') throw registry.fail('This captured issue has no permitted current-context action. Its full evidence remains in this report.',409,'REPORT_TARGET_UNAVAILABLE');
 return transaction(true,async client=>{
  await authorize(client,actor,registry.report(data.reportId));await recheckScope(client,actor,data.authorizedScope);
  const {rows}=await client.query(`SELECT i.payload,i.grouped_into_issue_id,shiftly_api.fn_attention_state(i) state
   FROM shiftly_schema.attention_issues i WHERE i.id=$2::bigint
    AND shiftly_api.fn_attention_can_view($1,i.payload->'scope',i.domain)`,[actor,issueId]);
  if(rows.length!==1||rows[0].grouped_into_issue_id||rows[0].state!=='ACTIVE') throw registry.fail('The issue changed, ended, was grouped or is no longer accessible. Generate a new report; the saved evidence remains available.',409,'REPORT_TARGET_UNAVAILABLE');
  const doc=rows[0].payload, target=doc.target, scope=doc.scope;
  if(target!==row.target||['division_id','department_id','clinical_unit_id','shift_date','shift_type_id','period_id','start_at','end_at','workflow_id','run_id','assignment_id','user_id'].some(k=>String(scope[k]??'')!==String(row.targetScope[k]??''))) throw registry.fail('The source context changed. Choose it explicitly from a new report.',409,'REPORT_TARGET_UNAVAILABLE');
  const permission={ASSIGNMENT_BOARD:'screen:clinical_assignment_board:open',STAFF_POOL:'screen:clinical_staff_pool:open',STAFF_COMPETENCIES:'screen:clinical_staff_competencies:open',PATIENTS:'screen:clinical_patient_administration:open',SHIFTS:'screen:shift_periods:open'}[target];
  if(!permission||(await permissions(client,actor,[permission]))[permission]!==true) throw registry.fail('Your current access does not allow this destination.',403,'REPORT_FORBIDDEN');
  if(['ASSIGNMENT_BOARD','STAFF_POOL'].includes(target)) {
   if(!scope.clinical_unit_id||!scope.shift_date||!scope.shift_type_id) throw registry.fail('There is no single unit and shift context. Use the saved source details and select an operational context explicitly.',409,'REPORT_TARGET_UNAVAILABLE');
   const {rows:roster}=await client.query(`SELECT EXISTS(SELECT 1 FROM shiftly_schema.shift_assignments a WHERE a.division_id=$1 AND a.department_id=$2
    AND a.shift_date=$3 AND a.shift_type_id=$4 AND a.status='APPROVED' AND COALESCE(a.is_absence,2)<>1
    AND ($5::integer IS NULL OR a.shift_period_id=$5) AND shiftly_api.shift_interval_end(a.shift_date,a.start_time,a.end_time)>now() AT TIME ZONE shiftly_api.fn_attention_zone()) ok`,
    [scope.division_id,scope.department_id,scope.shift_date,scope.shift_type_id,scope.period_id]);
   if(!roster[0].ok) throw registry.fail('No approved working roster remains for this exact context. Open Shift Periods explicitly; no different shift was selected.',409,'REPORT_TARGET_UNAVAILABLE');
  }
  if(target==='STAFF_POOL' && scope.assignment_id) {
   const {rows:assignment}=await client.query(`SELECT EXISTS(SELECT 1 FROM shiftly_schema.shift_assignments a
    WHERE a.id=$1 AND a.division_id=$2 AND a.department_id=$3 AND a.shift_date=$4 AND a.shift_type_id=$5
     AND a.status='APPROVED' AND COALESCE(a.is_absence,2)<>1 AND ($6::integer IS NULL OR a.user_id=$6)
     AND ($7::integer IS NULL OR a.shift_period_id=$7)) ok`,
    [scope.assignment_id,scope.division_id,scope.department_id,scope.shift_date,scope.shift_type_id,scope.user_id,scope.period_id]);
   if(!assignment[0].ok) throw registry.fail('The affected staff assignment changed or is unavailable. Generate a new report before opening its current context.',409,'REPORT_TARGET_UNAVAILABLE');
  }
  if(target==='SHIFTS' && doc.source_kind==='LIVE' && doc.reason_code==='ENDING_SOON') {
   const {rows:replacement}=await client.query('SELECT shiftly_api.fn_attention_replacement_coverage($1,$2::jsonb,$3::jsonb,$4) value',[actor,scope,doc.evidence?.live,'ACTIVE']);
   if(!replacement[0].value?.available) throw registry.fail('The replacement boundary is unavailable. Use the saved coverage evidence and select a new period explicitly.',409,'REPORT_TARGET_UNAVAILABLE');
   return {issueId,destination:target,scope,replacement:replacement[0].value,note:'Choose the replacement context explicitly; the outgoing shift is not the missing coverage.'};
  }
  if(target==='PATIENTS'&&!scope.clinical_unit_id) throw registry.fail('This finding has no single unit to open.',409,'REPORT_TARGET_UNAVAILABLE');
  if(target==='SHIFTS'&&!scope.shift_date&&!scope.period_id) throw registry.fail('This finding has no dated period context. Select a period explicitly; its evidence remains available here.',409,'REPORT_TARGET_UNAVAILABLE');
  return {issueId,destination:target,scope,note:'Opens the current operational context; this report remains an immutable generation.'};
 });
}
function exportData(dataset) {
  registry.assertClinicalPresentation(dataset,dataset.reportId,true);
  // PDF viewing and both exports require the full saved dataset. Retrieval owns
  // authorization; only /export requires the additional download permission.
  const def=registry.report(dataset.reportId);
  // Existing immutable boundary reports retain their original complete section
  // contract during the cache lifetime; new generations use the daily contract.
  const savedDefinition=dataset.reportId==='unit_handover_summary' && !dataset.unitContext
    ? {...def,sections:['overview','distributions','exceptions','patients','movements'].map(id=>({id}))}
    : dataset.reportId==='patient_handover_sheet' && dataset.patientContext?.version!==2
      ? {...def,sections:['patients','factors','events','issues'].map(id=>({id}))}
      : dataset.reportId==='changes_since_previous_shift' && dataset.changeContext?.version!==2
        ? {...def,sections:['changes','fields'].map(id=>({id}))}
        : dataset.reportId==='incoming_shift_readiness' && dataset.readinessContext?.version!==2
          ? {...def,sections:['findings','overview','requirements','staff','patients','competencies','capacity','pending'].map(id=>({id}))}
          : dataset.reportId==='outstanding_handover_issues' && dataset.issueContext?.version!==2
            ? {...def,sections:['issues','sources','lifecycle','associations','gaps'].map(id=>({id}))}
            : dataset.reportId==='workload_and_continuity' && dataset.workloadContext?.version!==2
              ? {...def,sections:['staff','allocations','continuity'].map(id=>({id}))}
              : dataset.reportId==='handover_review_follow_up' && dataset.reviewContext?.version!==4
                ? {...def,sections:(dataset.reviewContext?.version===3?['changes']:dataset.reviewContext?.version===2?['reviews']:['reviews','members','lifecycle','gaps']).map(id=>({id}))} : def;
  const count=validateDataset(savedDefinition,dataset);
  if (count!==dataset.rowCount) throw registry.fail('The complete saved report is unavailable. Generate the report again.',500,'REPORT_CONTRACT');
  const {authorizedScope,...data}=dataset; return data;
}
module.exports={catalog,lookups,generate,retrieve,preview,exportData,readinessTarget,outstandingTarget};
