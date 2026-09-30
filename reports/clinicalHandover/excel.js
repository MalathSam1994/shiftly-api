const ExcelJS = require('exceljs');
// Strings remain strings (never ExcelJS formula objects); identifiers remain text.
const text = value => value == null ? 'Not recorded / unavailable' : String(value);
function style(sheet, widths) {
  sheet.views=[{state:'frozen',ySplit:1,rightToLeft:false}];
  sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'},name:'Arial',size:11};
  sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF2F746A'}};
  sheet.columns.forEach((c,i)=>{c.width=widths[i]||25;});
  sheet.eachRow((row,n)=>{
    row.alignment={vertical:'top',wrapText:true};
    row.eachCell(cell=>{if(typeof cell.value==='string' && /[\u0600-\u06ff]/.test(cell.value))cell.alignment={vertical:'top',wrapText:true,readingOrder:'rtl'};});
    if(n>1) {row.font={name:'Arial',size:10};if(n%2===0)row.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FFF1F7F5'}};}
  });
  sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:widths.length}};
  sheet.pageSetup={paperSize:9,orientation:widths.length>5?'landscape':'portrait',fitToPage:true,fitToWidth:1,fitToHeight:0,printTitlesRow:'1:1'};
  sheet.headerFooter={oddFooter:'Clinical Handover Reports | Page &P of &N'};
}
async function excel(data) {
  const book=new ExcelJS.Workbook();book.creator='ShiftMix';book.created=new Date(data.generatedAt);
  const unit=data.reportId==='unit_handover_summary';
  const patient=data.reportId==='patient_handover_sheet';
  const changes=data.reportId==='changes_since_previous_shift';
  const readiness=data.reportId==='incoming_shift_readiness';
  const issues=data.reportId==='outstanding_handover_issues';
  const workload=data.reportId==='workload_and_continuity';
  const followUp=data.reportId==='handover_review_follow_up';
  const summary=book.addWorksheet(unit||readiness||issues||workload||followUp?'Overview':'Summary');summary.addRow(['Measure','Value','Definition / limitation']);
  summary.addRow(['Report',data.title,data.planningBasis]);
  summary.addRow(['Scope',data.scopeLabel,'Authorized scope at generation; access rechecked at export']);
  summary.addRow(['Reference time',new Date(data.referenceTime),'UTC instant; business zone '+data.businessTimezone]);
  summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
  summary.addRow(['Data reference',new Date(data.dataReferenceTime),'Recorded evidence as of this UTC instant; not a future outcome']);
  summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
  summary.addRow(['Generated',new Date(data.generatedAt),'Immutable generation '+data.generationId]);
  summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
  for(const s of data.summaries)summary.addRow([s.label,s.value==null?'Unavailable':s.value,text(s.definition)]);
  for(const d of data.metricDefinitions)summary.addRow([d.label||d.id,'Definition',text(d.definition)]);
  for(const l of data.sourceLimitations)summary.addRow(['Limitation','',text(l)]);
  if(unit) {
    for(const group of data.boundarySummaries) {
      summary.addRow(['BOUNDARY',new Date(group.boundary),`${group.unit} | ${group.incoming} | ${group.basis}`]);
      summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
      for(const key of ['incomingStart','incomingEnd','outgoingStart','outgoingEnd','movementStart','movementEndExclusive','movementObservedThrough','dataAt']) {
        summary.addRow([key,group[key]?new Date(group[key]):'Unavailable','UTC instant; business zone '+data.businessTimezone]);
        summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
      }
      summary.addRow(['Outgoing shift',group.outgoing,'Movement interval clipped at incoming boundary; end exclusive']);
      summary.addRow(['Movement evidence',group.movementAvailability,group.movementPartial?'Future-only or partially elapsed interval':'Elapsed interval']);
      summary.addRow(['Historical roster',group.contextChangedAfterBoundary?'Changed after boundary':'No later change in retained context','Current roster choice is not a historical scheduling audit']);
      for(const row of data.sections.find(s=>s.id==='overview').rows.filter(r=>r.boundaryKey===group.key)) summary.addRow([row.measure,row.value==null?'Unavailable':row.value,row.definition]);
      for(const row of group.distributions) summary.addRow([row.category,row.count,row.label]);
    }
  }
  if(patient) {
    for(const [key,value] of Object.entries(data.patientContext)) summary.addRow([key,text(value),'Boundary / recent-event window; timestamps carry the business offset']);
  }
  if(readiness) {
    const target=data.readinessContext;
    for(const key of ['unit','contextKey','periodId','shiftDate','shift','mode','intervalBasis','status','scopeNote','safetyNote','hardCapacityBehavior']) summary.addRow([key,text(target[key]),'Target context / current recorded plan']);
    for(const key of ['start','end','reference','dataReference']) {
      summary.addRow([key,new Date(target[key]),'UTC instant; business zone '+data.businessTimezone]);
      summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
    }
    for(const r of data.sections.find(s=>s.id==='overview').rows) summary.addRow([r.measure,r.value,r.definition]);
  }
  if(issues) {
    for(const key of ['mode','basis','canonicalization','completeness','limitation']) summary.addRow([key,text(data.issueContext[key]),'Stored issue evidence, not a new evaluation']);
    summary.addRow(['Evidence through',new Date(data.issueContext.evidenceThrough),'UTC instant; no future resolution predicted']);
    summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
    for(const category of data.categorySummaries)summary.addRow([category.category,category.count,'Canonical primary issue count']);
    if(data.issueContext.historical)summary.addRow(['Complete historical unresolved count','Unavailable','Last captured states are partial evidence, not a complete historical census']);
  }
  if(followUp) {
    for(const [key,value] of Object.entries(data.reviewContext)) {
      const instant=['reference','cohortStart','cohortEndExclusive'].includes(key);
      summary.addRow([key,instant?new Date(value):value,'Cohort / lifecycle reference basis']);
      if(instant) summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
    }
    summary.addRow(['Excluded canonical-link records',data.sections.find(s=>s.id==='gaps').total,'Separate evidence gaps; not extra logical reviews']);
    for(const s of data.statusSummaries) summary.addRow([s.status,s.count,'Current canonical groups; not member records']);
    for(const d of data.durationSummaries) {
      summary.addRow([d.measure,d.meanMinutes??'Unavailable',d.basis]);
      summary.addRow([d.measure+' - valid sample count',d.sampleCount,'Logical groups with comparable timestamps only']);
    }
  }
  if(workload) {
    for(const [key,value] of Object.entries(data.workloadContext)) summary.addRow([key,text(value),'Comparison / denominator basis']);
    for(const key of ['fullScopeStaffShifts','fullUnitComparable','fullUnitRetained','fullUnitChanged']) summary.addRow([key,data.totals[key],'Full scope, independent of staff display filters; no pooled capacity denominator']);
    for(const target of data.contextSummaries) {
      summary.addRow(['CONTEXT',target.side,`${target.shift} | ${target.shiftDate} | Period ${target.periodId}`]);
      for(const key of ['start','end','observationAt','evidenceThrough']) {
        summary.addRow([key,new Date(target[key]),'UTC instant; business zone '+data.businessTimezone]);
        summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
      }
      for(const key of ['basis','rosterChangedAfterCutoff','fullScopeStaffShifts','selectedStaffShifts','unresolvedAllocationEvidence','unrepresentedRosterRows','missingLocationRecords','limitation']) summary.addRow([key,target[key]??'Unavailable','Context evidence / scope']);
    }
  }
  if(changes) {
    for(const key of ['start','endExclusive','observedEndExclusive']) {
      summary.addRow([key,new Date(data.changeContext[key]),'UTC instant; half-open interval, business zone '+data.businessTimezone]);
      summary.getRow(summary.rowCount).getCell(2).numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
    }
    summary.addRow(['Interval basis',data.changeContext.basis,data.changeContext.partial?'Only elapsed portion has evidence':'Elapsed interval']);
    for(const c of data.categorySummaries) summary.addRow([c.category,c.changes,`${c.encounters} distinct encounters; categories overlap for mixed operations`]);
  }
  style(summary,[32,35,80]);
  const params=book.addWorksheet(unit||patient||changes||readiness||issues||workload||followUp?'Parameters and Definitions':'Parameters');params.addRow(['Parameter','Applied value','Meaning']);
  for(const [key,value] of Object.entries(data.parameters))params.addRow([key,data.selections[key]?.label||text(value),data.selections[key]?.meta?.basis||'Applied at generation']);
  if(unit||patient||changes||readiness||issues||workload||followUp) {
    for(const d of data.metricDefinitions)params.addRow([d.label||d.id,'Definition',text(d.definition)]);
    for(const note of data.sourceLimitations)params.addRow(['Limitation','',text(note)]);
  }
  style(params,[30,65,65]);
  const sections=unit?[...data.sections].sort((a,b)=>['patients','movements','exceptions','overview','distributions'].indexOf(a.id)-['patients','movements','exceptions','overview','distributions'].indexOf(b.id)):data.sections;
  sections.forEach((section,index)=>{
    if(unit && ['overview','distributions'].includes(section.id) || readiness && section.id==='overview')return;
    const sheet=book.addWorksheet((unit||patient||changes||readiness||issues||workload||followUp?section.title:`${index+1} ${section.title}`).replace(/[\\/*?:\[\]]/g,' ').slice(0,31));
    const columns=section.columns;
    sheet.addRow(columns.length?columns.map(c=>c.label):['Section status']);
    for(const row of section.rows) {
      const values=columns.map(c=>{
        const v=row[c.key]; if(v==null)return 'Not recorded / unavailable';
        if(c.type==='number')return v;
        if(c.type==='date'||c.type==='datetime')return new Date(c.type==='date'?v+'T00:00:00Z':v);
        return String(v);
      });
      const added=sheet.addRow(values);
      columns.forEach((c,i)=>{const cell=added.getCell(i+1);
        if(c.type==='identifier')cell.numFmt='@';
        if(c.type==='date')cell.numFmt='yyyy-mm-dd';
        if(c.type==='datetime')cell.numFmt='yyyy-mm-dd hh:mm:ss "UTC"';
        if(typeof values[i]==='string' && /[\u0600-\u06ff]/.test(values[i]))cell.alignment={readingOrder:'rtl',wrapText:true};
      });
    }
    for(const note of section.limitations)sheet.addRow(['Limitation: '+text(note)]);
    if(section.availability==='UNAVAILABLE')sheet.addRow(['Unavailable - no historical/current evidence substituted']);
    style(sheet,columns.length?columns.map(c=>c.type==='text'?40:24):[80]);
  });
  return book.xlsx.writeBuffer();
}
module.exports={excel};
