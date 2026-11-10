"""Descriptive T3 Diagnose metrics from immutable paired receipts. Never launches a trial or changes a seal."""
import hashlib,json,math,statistics,sys
from pathlib import Path
ROOT=Path(sys.argv[1]).resolve();RUN=ROOT/sys.argv[2];LIMIT=65536

def read(file):
 if file.is_symlink() or not file.is_file():raise ValueError('regular bounded artifact required')
 with file.open('rb') as stream:data=stream.read(LIMIT+1)
 if len(data)>LIMIT:raise ValueError('artifact bound exceeded')
 return data

def digest(data):return hashlib.sha256(data).hexdigest()
def obj(file):return json.loads(read(file))
def canonical(value):return json.dumps(value,sort_keys=True,separators=(',',':'))
def nearest(values,q):return sorted(values)[max(0,math.ceil(q*len(values))-1)] if values else None
def median(values):return statistics.median(values) if values else None

manifest=obj(RUN/'manifest.json');rows=[]
for item in manifest['files']:
 data=read(RUN/item['path'])
 if digest(data)!=item['sha256'] or len(data)!=item['bytes']:raise ValueError('slot integrity changed')
 rows.append(json.loads(data))
if len(rows)!=144:raise ValueError('full registered denominator required')
ARMS=('current-workflow','H1-A1-C1-lineage-view')
if {row['arm'] for row in rows}!=set(ARMS):raise ValueError('registered arms changed')
index=obj(ROOT/'test/fixtures/execution-eval/corpus.json')
cases={x['id']:x for x in index['cases'] if x['trial']=='diagnose'}
truth={k:obj(ROOT/v['expected']) for k,v in cases.items()}
if len(cases)!=12 or {row['caseId'] for row in rows}!=set(cases):raise ValueError('incident set changed')

def components(row):
 expected=truth[row['caseId']];result=row['result']
 return {'provenance':canonical(result['provenance'])==canonical(expected['provenance']),'nextAction':result['nextAction']==expected['nextAction']}

def scored(selected):
 outcome={'observations':len(selected),'provenanceMatches':0,'nextActionMatches':0,'jointMatches':0,'mismatches':[]}
 for row in selected:
  value=components(row);outcome['provenanceMatches']+=value['provenance'];outcome['nextActionMatches']+=value['nextAction']
  outcome['jointMatches']+=value['provenance'] and value['nextAction']
  if not(value['provenance'] and value['nextAction']):outcome['mismatches'].append({'slot':row['slot'],'caseId':row['caseId'],'arm':row['arm'],'provenance':value['provenance'],'nextAction':value['nextAction']})
 incidents=sorted({row['caseId'] for row in selected})
 outcome['incidents']=len(incidents)
 outcome['incidentsJointMatched']=sum(all(components(row)['provenance'] and components(row)['nextAction'] for row in selected if row['caseId']==case) for case in incidents)
 outcome['repeatedObservationsPerIncident']=outcome['observations']//max(1,len(incidents))
 return outcome

def phases(selected):
 def clock(key):return {'medianWallMs':median([r['integration']['scaffolding'][key]['wallMs'] for r in selected]),'medianParentCpuSeconds':median([r['integration']['scaffolding'][key]['parentCpuSeconds'] for r in selected]),'subprocessCpuSeconds':'unknown'}
 return {'observations':len(selected),'setup':clock('setup'),'current':clock('current'),
  'childProcessWall':{'medianMs':median([r['processWallMs'] for r in selected]),'nearestRankP95Ms':nearest([r['processWallMs'] for r in selected],.95)},
  'slotCpuSeconds':{'median':median([r['costs']['cpuSeconds'] for r in selected])},
  'containerCpuSeconds':{'median':median([r['containerCpuSeconds'] for r in selected]),'scope':'admitted-container-cgroup budget counter, never added to process CPU'},
  'clockScope':'setup and current are nested subsets of the scheduled child process total, never added to it'}

output={'v':1,'kind':'descriptive-diagnose-T3-analysis','captureManifestSha256':digest(read(RUN/'manifest.json')),'captureCode':manifest['code']['commit'],'methodSha256':manifest['methodSha256'],'inputSha256':manifest['inputSha256'],'expectedSha256':manifest['expectedSha256'],'analysisSha256':digest(read(Path(__file__))),'schedule':manifest['schedule'],'denominators':manifest['denominators'],
 'definitions':{'incident':'one distinct frozen labeled case id; twelve incidents','observation':'one scheduled case/arm/seed/cold-or-warm unit; six per incident per arm','incidentAccuracy':'joint provenance and next-action agreement counted once per incident only when every observation of that incident agrees','componentAccuracy':'sealed expected provenance object and next-action token compared separately per observation','mustNot':'no separate automated check exists; the sealed projection covers provenance and nextAction only','humanTimeToFind':'literal unknown in every slot; no timing measurement was taken','CPU':'scheduled parent process CPU plus direct child resourceUsage CPU; cgroup CPU and nested phase CPU are separate and never added','p95':'nearest rank ceil(.95*n)'},
 'components':{arm:scored([r for r in rows if r['arm']==arm]) for arm in ARMS},'byCondition':{},'scaffolding':{'materialized':sum(r['integration']['scaffolding']['state']=='materialized' for r in rows),'skipped':sum(r['integration']['scaffolding']['state']=='skipped' for r in rows),'skipReason':sorted({r['integration']['scaffolding']['reason'] for r in rows if r['integration']['scaffolding']['state']=='skipped'}),'skippedIncidents':sorted({r['caseId'] for r in rows if r['integration']['scaffolding']['state']=='skipped'}),'helperSha256':sorted({r['diagnoseSetupCode']['helperSha256'] for r in rows}),'fixtureFactorySha256':sorted({r['diagnoseSetupCode']['fixtureFactorySha256'] for r in rows}),'independentPhysicalAttestation':sorted({r['integration']['scaffolding']['independentPhysicalAttestation'] for r in rows})},
 'phases':{},'costs':manifest['costs'],'accounting':manifest['accounting'],'admission':manifest['admission'],'environment':manifest['environment'],'limitations':manifest['limitations'],'perIncident':[]}
for condition in ('cold','warm'):
 output['byCondition'][condition]={arm:scored([r for r in rows if r['condition']==condition and r['arm']==arm]) for arm in ARMS}
 output['phases'][condition]={arm:phases([r for r in rows if r['condition']==condition and r['arm']==arm]) for arm in ARMS}
 for case in sorted(cases):
  output['perIncident'].append({'caseId':case,'scenario':cases[case]['scenario'],'condition':condition,
   **{arm:{key:value for key,value in scored([r for r in rows if r['caseId']==case and r['condition']==condition and r['arm']==arm]).items() if key in ('observations','provenanceMatches','nextActionMatches','jointMatches')} for arm in ARMS},
   'expectedNextAction':truth[case]['nextAction'],'observedNextAction':{arm:sorted({r['result']['nextAction'] for r in rows if r['caseId']==case and r['condition']==condition and r['arm']==arm}) for arm in ARMS}})
print(json.dumps(output,indent=2))
