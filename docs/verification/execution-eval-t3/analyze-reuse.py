"""Descriptive T1 metrics from immutable receipts. Never launches a trial or changes a seal."""
import hashlib,json,math,random,statistics,sys
from pathlib import Path
ROOT=Path(sys.argv[1]).resolve();RUN=ROOT/sys.argv[2];LIMIT=65536

def read(file):
 if file.is_symlink() or not file.is_file():raise ValueError('regular bounded artifact required')
 with file.open('rb') as stream:data=stream.read(LIMIT+1)
 if len(data)>LIMIT:raise ValueError('artifact bound exceeded')
 return data

def digest(data):return hashlib.sha256(data).hexdigest()
def obj(file):return json.loads(read(file))
def nearest(values,q):return sorted(values)[max(0,math.ceil(q*len(values))-1)] if values else None
def interval(values):
 if not values:return None
 rng=random.Random(101);sample=[statistics.median(rng.choices(values,k=len(values))) for _ in range(1000)]
 return [nearest(sample,.025),nearest(sample,.975)]
manifest=obj(RUN/'manifest.json');rows=[]
for item in manifest['files']:
 data=read(RUN/item['path'])
 if digest(data)!=item['sha256'] or len(data)!=item['bytes']:raise ValueError('slot integrity changed')
 rows.append(json.loads(data))
if len(rows)!=144:raise ValueError('full registered denominator required')
index=obj(ROOT/'test/fixtures/execution-eval/corpus.json')
cases={x['id']:x for x in index['cases'] if x['trial']=='reuse'}
truth={k:obj(ROOT/v['expected']) for k,v in cases.items()}
pairs={}
for row in rows:
 key=(row['caseId'],row['seed'],row['repetition'],row['condition']);pair=pairs.setdefault(key,{})
 if row['arm'] in pair:raise ValueError('duplicate pair arm')
 pair[row['arm']]=row
if len(pairs)!=72 or any(set(x)!={'fresh','eligible-reuse'} for x in pairs.values()):raise ValueError('paired denominator changed')

def percentage(pair,reduction):
 a,b=pair['fresh'],pair['eligible-reuse'];x,y=a['costs']['cpuSeconds'],b['costs']['cpuSeconds']
 if a['status']!='succeeded' or b['status']!='succeeded' or not isinstance(x,(int,float)) or not isinstance(y,(int,float)) or x<=0:return None
 return (x-y if reduction else y-x)/x*100

def metric(selected,reduction):
 values=[percentage(p,reduction) for p in selected];known=[x for x in values if x is not None]
 return {'fullPairs':len(values),'knownPairs':len(known),'valuePct':(statistics.median(known) if reduction else nearest(known,.95)) if known and len(known)==len(values) else None,'median95PercentileBootstrap101':interval(known) if reduction and known and len(known)==len(values) else None,'rangePct':[min(known),max(known)] if known else None}

def phase_summary(selected):
 result={}
 for arm in ('fresh','eligible-reuse'):
  group=[p[arm] for p in selected];result[arm]={'rows':len(group)}
  for phase in ('sourceSetup','current','total'):
   values=[r['integration']['instrumentation'][phase] for r in group]
   result[arm][phase]={'medianWallMs':statistics.median(v['wallMs'] for v in values),'medianParentCpuSeconds':statistics.median(v['parentCpuSeconds'] for v in values),'subprocessCpuSeconds':'unknown'} if values else None
 return result

output={'v':1,'kind':'descriptive-reuse-T3-analysis','captureManifestSha256':digest(read(RUN/'manifest.json')),'captureCode':manifest['code']['commit'],'methodSha256':manifest['methodSha256'],'analysisSha256':digest(read(Path(__file__))),'denominators':manifest['denominators'],'definitions':{'eligible':'sealed expected eligibility.reuseStages is nonempty; never selected from observed hits','primaryNoHit':'frozen scenario exactly no-hit','sensitivityNoHit':'all frozen cases with empty expected reuseStages, including invalidation/fault suites','CPU':'registered parent plus reported direct-child process CPU; cgroup CPU and nested phase CPU are separate and never added','percentage':'100*(fresh-eligible)/fresh for reduction; inverse for overhead','p95':'nearest rank ceil(.95*n)','interval':'95 percent percentile interval,1000 bootstrap resamples,seed101; small synthetic sample only'},'conditions':{},'phaseSummaries':{},'perCase':[]}
for condition in ('cold','warm'):
 eligible=[p for key,p in pairs.items() if key[3]==condition and truth[key[0]]['eligibility']['reuseStages']]
 nohit=[p for key,p in pairs.items() if key[3]==condition and cases[key[0]]['scenario']=='no-hit']
 allmiss=[p for key,p in pairs.items() if key[3]==condition and not truth[key[0]]['eligibility']['reuseStages']]
 output['conditions'][condition]={'eligibleComputeReduction':metric(eligible,True),'noHitP95Overhead':metric(nohit,False),'allIneligibleP95Sensitivity':metric(allmiss,False)}
 output['phaseSummaries'][condition]=phase_summary([p for key,p in pairs.items() if key[3]==condition])
 for case in cases:
  group=[p for key,p in pairs.items() if key[3]==condition and key[0]==case]
  output['perCase'].append({'caseId':case,'scenario':cases[case]['scenario'],'condition':condition,'fullPairs':len(group),'freshMedianCpu':statistics.median(p['fresh']['costs']['cpuSeconds'] for p in group),'eligibleMedianCpu':statistics.median(p['eligible-reuse']['costs']['cpuSeconds'] for p in group),'pairedReduction':metric(group,True)})
false_hits=[];observed_hits=0
for row in rows:
 if row['arm']!='eligible-reuse':continue
 expected=set(truth[row['caseId']]['eligibility']['reuseStages']);integ=row['integration']
 for hit in integ['hits']:
  observed_hits+=1;stage=hit['stage'];position=['prepare','transform','evaluate'].index(stage)
  if stage not in expected or integ['fault']!='none' or integ['currentPayloadDigests'][position]!=integ['sourcePayloadDigests'][position]:false_hits.append({'slot':row['slot'],'stage':stage})
output['invariants']={'fullPairs':72,'observedReusedStages':observed_hits,'falseReusedStages':len(false_hits),'falseReuseEvidence':false_hits,'equalResultPairs':sum(p['fresh']['result']==p['eligible-reuse']['result'] for p in pairs.values()),'equalPayloadDigestPairs':sum(p['fresh']['integration']['currentPayloadDigests']==p['eligible-reuse']['integration']['currentPayloadDigests'] for p in pairs.values()),'equalEvaluatorMetricDigestPairs':sum(p['fresh']['integration']['currentMetricsSha256']==p['eligible-reuse']['integration']['currentMetricsSha256'] for p in pairs.values()),'freshEvaluators':sum(r['integration']['evaluatorFresh'] is True for r in rows),'immutableSourceRecords':sum(r['integration']['sourceRecordUnchanged'] is True for r in rows),'noSourceRows':sum(r['integration']['sourcePopulation']=='none' for r in rows),'sourceFaultRows':{kind:sum(r['integration']['fault']==kind for r in rows) for kind in ('none','corrupt','pruned','interrupted')}}
print(json.dumps(output,indent=2))
