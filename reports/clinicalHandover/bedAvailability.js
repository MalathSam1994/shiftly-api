// PostgreSQL owns scope, current occupancy, missing-data rules and complete totals.
const {fail}=require('./registry');
const c=(key,label,type='text')=>({key,label,type});
const columns=[c('division','Division'),c('department','Department'),c('unit','Unit'),
 c('totalBeds','Configured beds','number'),c('occupiedBeds','Recorded occupied beds','number'),
 c('unknownBeds','Patients without a recorded bed','number'),
 c('availableBeds','Available beds','number'),c('availabilityStatus','Note')];
async function read(client,{actor,parameters}) {
 const {rows}=await client.query('SELECT shiftly_api.fn_handover_available_beds_by_unit($1::integer,$2::jsonb) value',[actor,parameters]);
 const d=rows[0].value;
 if(d?.context?.version!==2) throw fail('Available beds reporting needs a database update. Apply the available-bed estimates update, then generate the report again.',409,'REPORT_UPDATE_REQUIRED');
 const estimated=d.totals.availabilityKind==='UPPER_BOUND';
 const capacityMissing=d.totals.availabilityKind==='CAPACITY_NOT_CONFIGURED';
 const availableSummary={
  label:estimated?'Available beds upper bound':capacityMissing?'Capacity not configured':'Available beds',
  value:estimated?d.totals.availableBedsUpperBound:d.totals.availableBeds,
  availability:capacityMissing?'UNAVAILABLE':'AVAILABLE',
  definition:estimated?'Upper bound across all included units: configured capacity minus recorded occupied room/bed locations, clamped to zero per unit. Needs verification because patients without a recorded bed may occupy additional beds.'
   :capacityMissing?'At least one included unit has no configured capacity, so neither total confirmed availability nor an overall upper bound can be calculated.'
   :'Configured capacity minus distinct recorded occupied room/bed locations, clamped to zero per unit. Every included unit has configured capacity and complete bed labels.'};
 return {rowGrain:'One active clinical unit in the authorized organization scope at generation time.',
  bedAvailabilityContext:d.context,totals:d.totals,
  summaries:[
   {label:'Units',value:d.totals.units,availability:'AVAILABLE',definition:'Active clinical units in the selected authorized scope, including units with no current patients.'},
   availableSummary,
   {label:'Units with incomplete data',value:d.totals.unavailableUnits,availability:'AVAILABLE',
    definition:'Units requiring verification of missing bed labels or configuration of missing bed capacity. Upper bounds are not confirmed availability.'}],
  metricDefinitions:[],sourceLimitations:d.notes,
  sections:[{id:'units',title:'Available beds by unit',grain:'active clinical unit',evidenceBasis:'CURRENT',
   availability:'AVAILABLE',limitations:[],columns,rows:d.units,total:d.units.length}]};
}
async function lookupUnits(client,{actor,parameters={},search='',offset=0,value=null}) {
 if(typeof search!=='string'||search.length>120||!Number.isInteger(offset)||offset<0||offset>10000)
  throw fail('Narrow the lookup search.');
 const {rows}=await client.query(`-- available_beds_by_unit: active unit lookup
  WITH scope AS MATERIALIZED (
   SELECT shiftly_api.fn_handover_report_scope($1::integer,$2::jsonb) value
  ), pairs AS MATERIALIZED (
   SELECT x FROM scope CROSS JOIN LATERAL jsonb_array_elements(value->'pairs') x
  ), choices AS MATERIALIZED (
   SELECT u.id value,u.unit_name||' | '||(a.x->>'department_name')||' | '||(a.x->>'division_name') label,
    jsonb_build_object('unitId',u.id,'divisionId',u.division_id,'departmentId',u.department_id,
     'divisionIdLabel',a.x->>'division_name','departmentIdLabel',a.x->>'department_name') meta
   FROM shiftly_schema.clinical_units u JOIN pairs a
    ON u.division_id=(a.x->>'division_id')::integer AND u.department_id=(a.x->>'department_id')::integer
   WHERE u.is_active
  ), matching AS MATERIALIZED (
   SELECT * FROM choices WHERE ($5::text IS NULL OR value::text=$5::text)
    AND ($3::text='' OR label ILIKE '%'||$3::text||'%' OR value::text=$3::text)
  ), page AS (
   SELECT * FROM matching ORDER BY label,value LIMIT 50 OFFSET $4::integer
  )
  SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY label,value) FROM page p),'[]'::jsonb),
   'total',(SELECT count(*) FROM matching),'offset',$4::integer,'limit',50,
   'basis','Current active clinical units in the authorized organization scope.',
   'business_timezone',(SELECT value->'business_timezone' FROM scope)) value`,[actor,parameters,search,offset,value]);
 return rows[0].value;
}
module.exports={read,lookupUnits};
