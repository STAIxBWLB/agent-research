/** Isolated executor program: receives one bounded request, never emits payload bytes or host paths. */
export const RETENTION_SCRIPT = String.raw`
import os,sys,json,re,stat,hashlib,uuid,fcntl,datetime
MAX_BYTES=256*1024*1024
MAX_META=256*1024
MAX_ADMIN=256*1024
ARCHIVE_BYTES=64*1024
MAX_FILES=500
STATE_BYTES=1024*1024
CAP=1024*1024*1024

def fail(message):
    raise ValueError(message)
def encoded(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=True).encode()
def digest(data):
    return hashlib.sha256(data).hexdigest()
def ident(value,kind='name'):
    pattern=r'[a-f0-9]{16}' if kind=='attempt' else r'[A-Za-z0-9][A-Za-z0-9_-]{0,79}' if kind=='study' else r'[a-z][a-z0-9_-]{0,31}'
    if not isinstance(value,str) or not re.fullmatch(pattern,value) or value in ('constructor','prototype','__proto__'):
        fail('invalid '+kind+' identity')
    return value
def hexhash(value):
    if not isinstance(value,str) or not re.fullmatch(r'[a-f0-9]{64}',value): fail('invalid digest identity')
    return value
def relative(value):
    if not isinstance(value,str) or not value or len(value.encode())>4096 or value.startswith('/') or chr(92) in value or any(ord(c)<32 or ord(c)==127 for c in value) or any(p in ('','.','..') for p in value.split('/')):
        fail('unsafe declared relative path')
    return value
def stamp(st):
    return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,st.st_ctime_ns,st.st_mode,st.st_nlink)
def physical(path,private=False):
    if not os.path.isabs(path) or os.path.normpath(path)!=path or os.path.realpath(path)!=path: fail('nonphysical executor directory')
    st=os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid!=os.getuid() or (private and stat.S_IMODE(st.st_mode)!=0o700): fail('executor directory ownership or mode refused')
    return path
def mkdir(path):
    try: os.mkdir(path,0o700)
    except FileExistsError: pass
    return physical(path,True)
def within(path,root):
    if not isinstance(path,str) or not path.startswith(root+'/') or os.path.normpath(path)!=path or os.path.realpath(path)!=path: fail('path escapes attempt workspace')
    parent=os.path.dirname(path)
    physical(parent)
    return path
def read_bytes(path,bound):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size>bound: fail('nonregular or oversized retained metadata')
        chunks=[]; count=0
        while True:
            chunk=os.read(fd,min(65536,bound-count+1))
            if not chunk: break
            count+=len(chunk)
            if count>bound: fail('retained metadata exceeds bound')
            chunks.append(chunk)
        if stamp(before)!=stamp(os.fstat(fd)): fail('retained metadata changed during read')
        return b''.join(chunks)
    finally: os.close(fd)
def syncdir(path):
    fd=os.open(path,os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)
def atomic(path,value,bound):
    data=encoded(value)
    if len(data)>bound: fail('retention metadata bound exceeded')
    tmp=path+'.'+uuid.uuid4().hex+'.tmp'
    fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    try:
        with os.fdopen(fd,'wb') as f: f.write(data);f.flush();os.fsync(f.fileno())
        os.replace(tmp,path);syncdir(os.path.dirname(path))
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
def inventory(root,copy_to=None,max_bytes=MAX_BYTES,max_files=MAX_FILES,max_directories=1000,code=False):
    files=[]; directories=[]; count=0; total=0
    def walk(path,rel,depth):
        nonlocal count,total
        if depth>64: fail('artifact nesting exceeds bound')
        before=os.lstat(path)
        if (stat.S_ISLNK(before.st_mode) and not code) or before.st_uid!=os.getuid(): fail('artifact link or ownership refused')
        if stat.S_ISDIR(before.st_mode):
            if len(directories)>=max_directories: fail('artifact directory bound exceeded')
            if rel: directories.append(rel)
            if copy_to is not None and rel: os.mkdir(os.path.join(copy_to,rel),0o700)
            entries=[]
            with os.scandir(path) as stream:
                for entry in stream:
                    if len(entries)>=max_files+max_directories: fail('artifact entry bound exceeded')
                    entries.append(entry.name)
            for entry in sorted(entries):
                child=entry if not rel else rel+'/'+entry
                if code:
                    if len(os.fsencode(child))>4096: fail('code snapshot path bound exceeded')
                else: relative(child)
                walk(os.path.join(path,entry),child,depth+1)
        elif code and stat.S_ISLNK(before.st_mode):
            if count>=max_files: fail('code snapshot entry bound exceeded')
            target=os.fsencode(os.readlink(path));count+=1;total+=len(target)
            if total>max_bytes: fail('code snapshot payload bound exceeded')
            files.append({'path':rel,'bytes':len(target),'sha256':digest(target),'kind':'symlink'})
        elif stat.S_ISREG(before.st_mode):
            if before.st_nlink!=1 or count>=max_files or before.st_size>max_bytes-total: fail('artifact file or payload bound exceeded')
            count+=1; amount=0; h=hashlib.sha256()
            fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            target=None
            try:
                if stamp(os.fstat(fd))!=stamp(before): fail('artifact changed before read')
                if copy_to is not None:
                    target=open(os.path.join(copy_to,rel),'xb')
                    os.fchmod(target.fileno(),0o400)
                while True:
                    chunk=os.read(fd,min(65536,max_bytes-total-amount+1))
                    if not chunk: break
                    amount+=len(chunk)
                    if amount>before.st_size or amount>max_bytes-total: fail('artifact grew during read')
                    h.update(chunk)
                    if target: target.write(chunk)
                if amount!=before.st_size or stamp(os.fstat(fd))!=stamp(before): fail('artifact changed during read')
                if target: target.flush();os.fsync(target.fileno())
            finally:
                os.close(fd)
                if target: target.close()
            total+=amount;record={'path':rel,'bytes':amount,'sha256':h.hexdigest()}
            if code: record['mode']=stat.S_IMODE(before.st_mode)
            files.append(record)
        else: fail('artifact special file refused')
        if stamp(os.lstat(path))!=stamp(before): fail('artifact changed during verification')
    physical(root)
    walk(root,'',0)
    return sorted(files,key=lambda item:item['path']), sorted(directories),total

def bounded_copy(source,target=None):
    st=os.lstat(source)
    if stat.S_ISDIR(st.st_mode):
        if target is not None: os.mkdir(target,0o700)
        return inventory(source,target)
    if not stat.S_ISREG(st.st_mode): fail('input must be a regular file or directory')
    # Reuse the same bounded file copier without accepting siblings.
    parent=os.path.dirname(source); name=os.path.basename(source)
    fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        if stamp(before)!=stamp(st) or st.st_nlink!=1 or st.st_uid!=os.getuid() or st.st_size>MAX_BYTES: fail('unsafe input file')
        h=hashlib.sha256();size=0
        out=open(target,'xb') if target is not None else None
        try:
            if out: os.fchmod(out.fileno(),0o400)
            while True:
                chunk=os.read(fd,min(65536,MAX_BYTES-size+1))
                if not chunk: break
                size+=len(chunk)
                if size>st.st_size or size>MAX_BYTES: fail('input grew during copy')
                h.update(chunk)
                if out: out.write(chunk)
            if out: out.flush();os.fsync(out.fileno())
        finally:
            if out: out.close()
        if size!=st.st_size or stamp(before)!=stamp(os.fstat(fd)) or stamp(st)!=stamp(os.lstat(source)): fail('input changed during copy')
        return [{'path':'','bytes':size,'sha256':h.hexdigest()}],[],size
    finally: os.close(fd)
def selected_inventory(root,paths):
    files=[];directories=set();total=0
    for path in paths:
        part,dirs,size=bounded_copy(within(os.path.join(root,path),root))
        total+=size
        for item in part:
            files.append({**item,'path':path+('/'+item['path'] if item['path'] else '')})
        if stat.S_ISDIR(os.lstat(os.path.join(root,path)).st_mode): directories.add(path)
        for directory in dirs: directories.add(path+'/'+directory)
        components=path.split('/')
        for count in range(1,len(components)): directories.add('/'.join(components[:count]))
    if len(files)>MAX_FILES or total>MAX_BYTES: fail('aggregate output bound exceeded')
    return sorted(files,key=lambda item:item['path']),sorted(directories),total

def writable_remove(path):
    # Disposal validates structure without rereading payload or imposing a second payload limit on sidecars.
    if os.path.realpath(path)!=path: fail('unsafe disposal path')
    count=0
    for root,dirs,files in os.walk(path,topdown=True,followlinks=False):
        count+=len(dirs)+len(files)
        if count>3000 or os.path.realpath(root)!=root: fail('unsafe disposal tree')
        os.chmod(root,0o700)
        for name in dirs:
            st=os.lstat(os.path.join(root,name))
            if not stat.S_ISDIR(st.st_mode): fail('unsafe disposal directory')
        for name in files:
            st=os.lstat(os.path.join(root,name))
            if not stat.S_ISREG(st.st_mode) or st.st_nlink!=1: fail('unsafe disposal file')
    for root,dirs,files in os.walk(path,topdown=False,followlinks=False):
        for file in files: os.unlink(os.path.join(root,file))
        for directory in dirs: os.rmdir(os.path.join(root,directory))
    os.rmdir(path)
def freeze_dirs(root):
    for base,dirs,files in os.walk(root,topdown=False,followlinks=False): os.chmod(base,0o500)
def key(ref):
    return ident(ref['attemptId'],'attempt')+'/'+ident(ref['stage'])
def ref_for(entry):
    return {'attemptId':entry['attemptId'],'stage':entry['stage'],'sha256':entry['sha256']}
def archive_path(store,aid):
    ident(aid,'attempt')
    return os.path.join(store,'archive',aid[:2],aid+'.json')
def immutable(path,value,bound=MAX_META):
    if os.path.lexists(path):
        if read_bytes(path,bound)!=encoded(value): fail('immutable retention provenance mismatch')
    else:
        atomic(path,value,bound);os.chmod(path,0o400)
def read_archive(store,aid):
    path=archive_path(store,aid)
    if not os.path.lexists(path): return None
    if os.path.realpath(path)!=path: fail('unsafe retention archive path')
    record=json.loads(read_bytes(path,ARCHIVE_BYTES))
    if record.get('v')!=1 or record.get('attemptId')!=aid or not isinstance(record.get('entries'),dict): fail('invalid retention archive shard')
    return record
def archives(store):
    base=os.path.join(store,'archive')
    if not os.path.lexists(base): return
    physical(base,True);count=0
    with os.scandir(base) as prefixes:
        for prefix in prefixes:
            if not re.fullmatch(r'[a-f0-9]{2}',prefix.name): fail('invalid retention archive prefix')
            physical(prefix.path,True)
            with os.scandir(prefix.path) as records:
                for item in records:
                    if not re.fullmatch(r'[a-f0-9]{16}\.json',item.name) or item.name[:2]!=prefix.name: fail('invalid retention archive filename')
                    count+=1
                    if count>1000000: fail('retention archive exceeds bounded record count; archive this study before adding evidence')
                    aid=item.name[:-5]
                    yield aid,read_archive(store,aid)
def effective_entry(entry,store):
    result=dict(entry);result['_adminBytes']=0;root=os.path.join(store,'objects',ident(entry['attemptId'],'attempt'),ident(entry['stage']))
    for name in ('tombstone','disposed'):
        marker=os.path.join(root,name+'.json')
        if os.path.lexists(marker):
            if os.path.realpath(marker)!=marker: fail('unsafe retention disposal provenance')
            marker_bytes=read_bytes(marker,4096);result['_adminBytes']+=len(marker_bytes)
            record=json.loads(marker_bytes)
            if record!={'v':1,'ref':ref_for(entry)}: fail('retention disposal provenance mismatch')
            result['tombstone']=True
            if name=='disposed':
                if os.path.lexists(os.path.join(root,'data')): fail('disposed retention payload unexpectedly remains')
                result['bytes']=result['metadataBytes']
    return result
def all_entries(state,store):
    for entry in state['entries'].values(): yield effective_entry(entry,store)
    for aid,record in archives(store):
        if aid in state['attempts']: continue
        for entry in record['entries'].values(): yield effective_entry(entry,store)
def find_entry(ref,state,store):
    k=key(ref)
    entry=state['entries'].get(k)
    if entry is None:
        archive=read_archive(store,ref['attemptId'])
        entry=archive['entries'].get(k) if archive else None
    if entry and (entry['attemptId']!=ref['attemptId'] or entry['stage']!=ref['stage']): fail('retention index provenance mismatch')
    return effective_entry(entry,store) if entry else None
def compact(state,store):
    released=[aid for aid,a in state['attempts'].items() if not a['active'] and a['reservation']==0]
    if not released: return
    base=mkdir(os.path.join(store,'archive'))
    for aid in released:
        entries={k:e for k,e in state['entries'].items() if e['attemptId']==aid}
        if len(entries)>16: fail('unsupported released attempt stage count; retain the original index for compatible recovery')
        record={'v':1,'attemptId':aid,'reservation':state['attempts'][aid],'entries':entries}
        prefix=mkdir(os.path.join(base,aid[:2]));immutable(archive_path(store,aid),record,ARCHIVE_BYTES)
    # Publishing a shard before removing its active-index rows is crash-safe: readers deduplicate by attempt id.
    for aid in released: del state['attempts'][aid]
    state['entries']={k:e for k,e in state['entries'].items() if e['attemptId'] not in released}

def manifest_for(ref,state,store):
    k=key(ref);hexhash(ref['sha256'])
    entry=find_entry(ref,state,store)
    if not entry or entry['tombstone'] or entry['sha256']!=ref['sha256']: fail('retained source missing, pruned or digest mismatch')
    root=physical(os.path.join(store,'objects',entry['attemptId'],entry['stage']))
    raw=read_bytes(os.path.join(root,'manifest.json'),MAX_META)
    if digest(raw)!=ref['sha256']: fail('retained manifest integrity mismatch')
    manifest=json.loads(raw)
    if manifest.get('v')!=1: fail('unsupported retained manifest')
    if manifest['studyId']!=study or manifest['attemptId']!=entry['attemptId'] or manifest['stage']!=entry['stage']: fail('retained manifest identity mismatch')
    if not isinstance(manifest.get('outputs'),dict) or len(manifest['outputs'])>32: fail('invalid retained output declaration')
    for port,path in manifest['outputs'].items(): ident(port);relative(path)
    files,directories,total=inventory(os.path.join(root,'data'))
    if files!=manifest['files'] or directories!=manifest['directories']: fail('retained payload integrity mismatch')
    return manifest,root

def perform(q):
    global study
    if not isinstance(q,dict): fail('request object required')
    study=ident(q.get('studyId'),'study');op=q.get('op')
    if op not in ('reserve','release','seal','verify','materialize','inspect','prune','snapshot'): fail('unsupported retention operation')
    base=physical(sys.argv[1],True)
    study_root=os.path.join(base,study);store=os.path.join(study_root,'.retained')
    if op=='reserve':
        amount=q.get('reservationBytes',MAX_BYTES+MAX_META+MAX_ADMIN)
        if type(amount)!=int or amount<1 or amount>MAX_BYTES+MAX_META+MAX_ADMIN: fail('invalid retention cap or reservation')
        requested_cap=q.get('capBytes',CAP)
        if type(requested_cap)!=int or requested_cap<1 or requested_cap>1024*CAP: fail('invalid retention cap or reservation')
        # New-store admission has no prior state: reject impossible capacity before any directory creation.
        if not os.path.lexists(os.path.join(store,'state.json')) and amount>requested_cap: fail('study retention cap full; prune explicit evidence or raise cap before admission')
    if op=='inspect' and (not os.path.lexists(study_root) or not os.path.lexists(store)):
        return {'op':op,'entries':[],'reservations':[],'usedBytes':0,'reservedBytes':0,'capBytes':CAP}
    if op=='reserve':
        study_root=mkdir(study_root);store=mkdir(store)
        for name in ('objects','quarantine'): mkdir(os.path.join(store,name))
    else: physical(study_root,True);physical(store,True)
    lock=os.path.join(store,'lock')
    try:
        lock_fd=os.open(lock,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        lock_stat=os.fstat(lock_fd)
        if not stat.S_ISREG(lock_stat.st_mode) or lock_stat.st_nlink!=1 or lock_stat.st_uid!=os.getuid(): fail('invalid retention lock')
        try: fcntl.flock(lock_fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError: fail('retention operation busy; retry after the current owner finishes')
    except ValueError: raise
    except Exception: fail('retention operation active or invalid lock; reconcile its owner before retrying')
    try:
        state_path=os.path.join(store,'state.json')
        if os.path.exists(state_path): state=json.loads(read_bytes(state_path,STATE_BYTES))
        else: state={'v':1,'capBytes':CAP,'attempts':{},'entries':{}}
        if state.get('v')!=1: fail('unsupported retention state')
        def save():
            compact(state,store);atomic(state_path,state,STATE_BYTES)
        if op not in ('inspect','verify','snapshot'): compact(state,store)
        def usage():
            used=0;administrative=0
            for entry in all_entries(state,store): used+=entry['bytes'];administrative+=entry.get('_adminBytes',0)
            administrative+=sum(os.lstat(archive_path(store,aid)).st_size for aid,_ in archives(store))
            used+=administrative
            remaining=0
            for aid,a in state['attempts'].items():
                own=sum(e['bytes'] for e in state['entries'].values() if e['attemptId']==aid and not e['tombstone'])
                remaining+=max(0,a['reservation']-own)
            return used,remaining,administrative
        if op=='reserve':
            aid=ident(q.get('attemptId'),'attempt');amount=q.get('reservationBytes',MAX_BYTES+MAX_META+MAX_ADMIN);cap=q.get('capBytes',state['capBytes'])
            if type(amount)!=int or amount<1 or amount>MAX_BYTES+MAX_META+MAX_ADMIN or type(cap)!=int or cap<1 or cap>1024*CAP: fail('invalid retention cap or reservation')
            if read_archive(store,aid) is not None and aid not in state['attempts']: fail('completed reservation cannot be reopened')
            if aid in state['attempts']:
                if not state['attempts'][aid]['active']: fail('completed reservation cannot be reopened')
                if state['attempts'][aid]['reservation']!=amount or state['capBytes']!=cap: fail('reservation identity changed during duplicate admission')
                return {'op':op}
            used,reserved,administrative=usage()
            if used+reserved+amount>cap: fail('study retention cap full; prune explicit evidence or raise cap before admission')
            state['capBytes']=cap;state['attempts'][aid]={'reservation':amount,'active':True,'consumers':[]};save()
            return {'op':op}
        if op=='release':
            aid=ident(q.get('attemptId'),'attempt');a=state['attempts'].get(aid)
            if not a:
                if read_archive(store,aid) is not None: return {'op':op}
                fail('reservation missing')
            a['reservation']=0;a['active']=False;a['consumers']=[];save();return {'op':op}
        if op=='inspect':
            used,reserved,administrative=usage();offset=q.get('offset',0);limit=q.get('limit',200)
            if type(offset)!=int or offset<0 or offset>16000000 or type(limit)!=int or limit<1 or limit>500: fail('invalid retention inventory page')
            entries=[];total=0
            for e in all_entries(state,store):
                active=state['attempts'].get(e['attemptId'],{}).get('active',False) or any(a['active'] and key(ref_for(e)) in a['consumers'] for a in state['attempts'].values())
                if total>=offset and len(entries)<limit: entries.append({'ref':ref_for(e),'bytes':e['bytes'],'tombstone':e['tombstone'],'active':active})
                total+=1
            reservations=[{'attemptId':aid,'active':a['active'],'reservationBytes':a['reservation']} for aid,a in sorted(state['attempts'].items())]
            archived=sum(1 for aid,_ in archives(store) if aid not in state['attempts'])
            result={'op':op,'entries':entries,'reservations':reservations,'archivedReservations':archived,'offset':offset,'limit':limit,'total':total,'remaining':max(0,total-offset-len(entries)),'usedBytes':used,'reservedBytes':reserved,'administrativeBytes':administrative,'capBytes':state['capBytes']}
            if len(encoded(result))>STATE_BYTES: fail('retention inventory exceeds response bound')
            return result
        if op=='verify':
            manifest,root=manifest_for(q['ref'],state,store)
            return {'op':op,'manifest':manifest,'sha256':q['ref']['sha256']}
        if op=='prune':
            refs=q.get('refs')
            if not isinstance(refs,list) or not refs or len(refs)>500: fail('prune requires 1..500 explicit references')
            keys=[key(ref) for ref in refs]
            if len(keys)!=len(set(keys)): fail('duplicate prune references')
            for ref in refs:
                k=key(ref);entry=find_entry(ref,state,store)
                if not entry or entry['sha256']!=hexhash(ref['sha256']): fail('prune source identity missing')
                if state['attempts'].get(entry['attemptId'],{}).get('active',False) or any(a['active'] and k in a['consumers'] for a in state['attempts'].values()): fail('active producer or consumer prevents prune')
            fingerprint=digest(encoded({'state':state,'refs':sorted(refs,key=key),'entries':[find_entry(ref,state,store) for ref in sorted(refs,key=key)]}))
            if q.get('fingerprint') is None: return {'op':op,'fingerprint':fingerprint,'pruned':0}
            if q['fingerprint']!=fingerprint: fail('stale prune fingerprint')
            # Immutable tombstones precede byte deletion; a crash cannot expose half-disposed payloads.
            for ref in refs:
                root=physical(os.path.join(store,'objects',ref['attemptId'],ref['stage']))
                immutable(os.path.join(root,'tombstone.json'),{'v':1,'ref':ref_for(find_entry(ref,state,store))},4096)
            for ref in refs:
                root=os.path.join(store,'objects',ref['attemptId'],ref['stage'])
                data=os.path.join(root,'data')
                if os.path.exists(data): writable_remove(data)
                immutable(os.path.join(root,'disposed.json'),{'v':1,'ref':ref_for(find_entry(ref,state,store))},4096)
            save()
            return {'op':op,'fingerprint':fingerprint,'pruned':len(keys)}
        aid=ident(q.get('attemptId'),'attempt');attempt=state['attempts'].get(aid)
        if not attempt or not attempt['active']: fail('active retention reservation required')
        workspace=physical(os.path.join(study_root,aid),True)
        def code_hash(source):
            root=within(source,workspace);physical(root)
            files,dirs,_=inventory(root,max_bytes=MAX_BYTES,max_files=100000,max_directories=100000,code=True)
            return digest(encoded({'files':files,'directories':dirs}))
        if op=='snapshot': return {'op':op,'sha256':code_hash(q['source'])}
        stage=ident(q.get('stage'))
        if op=='seal':
            source=within(q['source'],workspace);physical(source)
            observation=q['observed'];identity=q['identity'];outputs=q['outputs'];metadata_limit=q.get('metadataLimit',MAX_META)
            if type(metadata_limit)!=int or metadata_limit<0 or metadata_limit>MAX_META: fail('invalid shared metadata limit')
            if not isinstance(observation,dict) or set(observation)!={'containerId','endedAt','exitCode'} or not isinstance(identity,dict) or set(identity)!={'definitionHash','inputHashes','codeTree','image','argvHash','envHash','seed','producerVersion'}: fail('invalid producing manifest fields')
            if observation.get('exitCode')!=0 or not re.fullmatch(r'[a-f0-9]{64}',observation.get('containerId','')) or not isinstance(observation.get('endedAt'),str): fail('observed successful termination receipt required')
            if len(observation['endedAt'])>64: fail('invalid observed termination time')
            try: datetime.datetime.fromisoformat(observation['endedAt'].replace('Z','+00:00'))
            except Exception: fail('invalid observed termination time')
            for field in ('definitionHash','argvHash','envHash'): hexhash(identity.get(field))
            if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}',identity.get('codeTree','')) or not isinstance(identity.get('image'),str) or not re.search(r'@sha256:[a-f0-9]{64}$',identity['image']): fail('invalid producing execution identity')
            if type(identity.get('seed'))!=int or not isinstance(identity.get('producerVersion'),str) or len(identity['producerVersion'])>128: fail('invalid producer version or seed')
            if not isinstance(identity.get('inputHashes'),dict) or len(identity['inputHashes'])>32: fail('invalid input identities')
            for port,h in identity['inputHashes'].items(): ident(port);hexhash(h)
            if not isinstance(outputs,dict) or len(outputs)>32: fail('invalid declared outputs')
            for port,path in outputs.items(): ident(port);relative(path)
            paths=list(outputs.values())
            if any(a==b or a.startswith(b+'/') or b.startswith(a+'/') for i,a in enumerate(paths) for b in paths[i+1:]): fail('overlapping declared outputs')
            k=aid+'/'+stage
            if k in state['entries']:
                prior=state['entries'][k]
                manifest,root=manifest_for(ref_for(prior),state,store)
                if manifest['identity']!=identity or manifest['observed']!=observation or manifest['outputs']!=outputs: fail('stage already sealed with different provenance')
                sidecars=sum(e['metadataBytes'] for e in state['entries'].values() if e['attemptId']==aid)
                if sidecars>metadata_limit: fail('cumulative shared metadata limit exceeded')
                return {'op':op,'manifest':manifest,'sha256':prior['sha256'],'manifestBytes':prior['metadataBytes'],'sidecarBytes':sidecars}
            published_root=os.path.join(store,'objects',aid,stage)
            if os.path.lexists(published_root):
                physical(published_root)
                raw=read_bytes(os.path.join(published_root,'manifest.json'),MAX_META);manifest=json.loads(raw)
                if manifest.get('v')!=1 or manifest.get('studyId')!=study or manifest.get('attemptId')!=aid or manifest.get('stage')!=stage or manifest.get('identity')!=identity or manifest.get('observed')!=observation or manifest.get('outputs')!=outputs: fail('unindexed publication provenance mismatch')
                files,dirs,total=inventory(os.path.join(published_root,'data'))
                original,original_dirs,_=selected_inventory(source,paths)
                if manifest.get('files')!=files or manifest.get('directories')!=dirs or original!=files or original_dirs!=dirs: fail('unindexed publication integrity mismatch')
                siblings=[e for e in state['entries'].values() if e['attemptId']==aid and not e['tombstone']]
                if sum(e['payloadBytes'] for e in siblings)+total>MAX_BYTES or sum(e['files'] for e in siblings)+len(files)>MAX_FILES or sum(e['metadataBytes'] for e in siblings)+len(raw)>metadata_limit: fail('cumulative attempt output or metadata limit exceeded')
                if sum(e['bytes'] for e in siblings)+total+len(raw)>attempt['reservation']: fail('retention reservation exceeded')
                state['entries'][k]={'attemptId':aid,'stage':stage,'sha256':digest(raw),'bytes':total+len(raw),'payloadBytes':total,'metadataBytes':len(raw),'files':len(files),'tombstone':False};save()
                return {'op':op,'manifest':manifest,'sha256':digest(raw),'manifestBytes':len(raw),'sidecarBytes':sum(e['metadataBytes'] for e in siblings)+len(raw)}
            tmp=os.path.join(store,'quarantine',aid+'-'+stage+'.pending')
            if os.path.lexists(tmp): writable_remove(tmp)
            os.mkdir(tmp,0o700);data=os.path.join(tmp,'data');os.mkdir(data,0o700)
            try:
                # Copy only declared outputs, while retaining their paths under the stage output root.
                for path in paths:
                    selected=within(os.path.join(source,path),source)
                    dest=os.path.join(data,path);os.makedirs(os.path.dirname(dest),mode=0o700,exist_ok=True)
                    bounded_copy(selected,dest)
                files,dirs,total=inventory(data)
                # Rehash producer bytes without a second payload copy before publication.
                original,original_dirs,_=selected_inventory(source,paths)
                if original!=files or original_dirs!=dirs: fail('producer output changed during seal')
                manifest={'v':1,'studyId':study,'attemptId':aid,'stage':stage,'identity':identity,'observed':observation,'outputs':outputs,'files':files,'directories':dirs}
                raw=encoded(manifest)
                siblings=[e for e in state['entries'].values() if e['attemptId']==aid and not e['tombstone']]
                if sum(e['payloadBytes'] for e in siblings)+total>MAX_BYTES or sum(e['files'] for e in siblings)+len(files)>MAX_FILES or sum(e['metadataBytes'] for e in siblings)+len(raw)>metadata_limit: fail('cumulative attempt output or metadata limit exceeded')
                if sum(e['bytes'] for e in siblings)+total+len(raw)>attempt['reservation']: fail('retention reservation exceeded')
                atomic(os.path.join(tmp,'manifest.json'),manifest,MAX_META)
                parent=mkdir(os.path.join(store,'objects',aid));final=os.path.join(parent,stage)
                if os.path.lexists(final): fail('publication changed under retention lock; inspect executor integrity')
                freeze_dirs(data);os.chmod(os.path.join(tmp,'manifest.json'),0o400)
                os.rename(tmp,final);syncdir(parent)
                state['entries'][k]={'attemptId':aid,'stage':stage,'sha256':digest(raw),'bytes':total+len(raw),'payloadBytes':total,'metadataBytes':len(raw),'files':len(files),'tombstone':False}
                save()
                return {'op':op,'manifest':manifest,'sha256':digest(raw),'manifestBytes':len(raw),'sidecarBytes':sum(e['metadataBytes'] for e in siblings)+len(raw)}
            finally:
                if os.path.exists(tmp): writable_remove(tmp)
        if op=='materialize':
            inputs=q['inputs'];target=within(q['target'],workspace);task_root=within(q['taskRoot'],workspace)
            if not isinstance(inputs,dict) or len(inputs)>32: fail('invalid input ports')
            has_task=any(isinstance(descriptor,dict) and 'task' in descriptor for descriptor in inputs.values())
            def verify_task():
                if not has_task: return
                expected=hexhash(q.get('expectedTaskTreeHash'))
                physical(task_root)
                task_files,_,_=inventory(task_root,max_bytes=64*1024*1024)
                pairs=sorted([[item['path'],item['sha256']] for item in task_files],key=lambda item:item[0].encode('utf-16-be','surrogatepass'))
                actual=digest(json.dumps(pairs,separators=(',',':'),ensure_ascii=False).encode())
                if actual!=expected: fail('frozen task snapshot integrity mismatch')
            def verify_code():
                if q.get('codeRoot') is None and q.get('expectedCodeHash') is None: return
                expected=hexhash(q.get('expectedCodeHash'))
                if code_hash(q.get('codeRoot'))!=expected: fail('frozen code snapshot integrity mismatch')
            verify_task();verify_code()
            sources=[];dependencies=[]
            for port,descriptor in inputs.items():
                ident(port)
                if set(descriptor)=={'task'}:
                    path=relative(descriptor['task'])
                    if path=='evaluator' or path.startswith('evaluator/'): fail('evaluator task path is private')
                    physical(task_root);source=within(os.path.join(task_root,path),task_root)
                elif 'ref' in descriptor and set(descriptor).issubset({'ref','output'}):
                    manifest,root=manifest_for(descriptor['ref'],state,store);dependencies.append(key(descriptor['ref']))
                    if 'output' in descriptor:
                        name=ident(descriptor['output'])
                        if name not in manifest['outputs']: fail('undeclared upstream output')
                        source=os.path.join(root,'data',manifest['outputs'][name])
                    else: source=os.path.join(root,'data')
                    if os.path.realpath(source)!=source: fail('unsafe retained input source')
                else: fail('undeclared input source')
                sources.append((port,source,descriptor))
            marker=target+'.retention.json'
            if os.path.lexists(target):
                receipt=json.loads(read_bytes(marker,MAX_META))
                if receipt.get('sources')!=digest(encoded(inputs)): fail('existing consumer input identities changed')
                files,dirs,_=inventory(target)
                if sorted(os.listdir(target))!=sorted(inputs): fail('undeclared materialized input')
                if files!=receipt['files'] or dirs!=receipt['directories']: fail('existing consumer snapshot integrity mismatch')
                for port,source,descriptor in sources:
                    part,part_dirs,_=bounded_copy(source)
                    expected=digest(encoded({'files':part,'directories':part_dirs}))
                    actual_files,actual_dirs,_=bounded_copy(os.path.join(target,port))
                    if expected!=receipt['payloadHashes'][port] or receipt['inputHashes'][port]!=(descriptor['ref']['sha256'] if 'ref' in descriptor else expected) or digest(encoded({'files':actual_files,'directories':actual_dirs}))!=expected: fail('consumer source or payload changed since materialization')
                verify_task();verify_code()
                return {'op':op,'inputHashes':receipt['inputHashes'],'files':files}
            # Record consumer references before any copy; a crash keeps the source protected.
            attempt['consumers']=sorted(set(attempt['consumers']+dependencies));save()
            parent=physical(os.path.dirname(target));tmp=target+'.pending'
            if os.path.lexists(tmp): writable_remove(tmp)
            os.mkdir(tmp,0o700)
            try:
                hashes={};payload_hashes={};total=0;count=0
                for port,source,descriptor in sources:
                    files,dirs,size=bounded_copy(source,os.path.join(tmp,port));count+=len(files);total+=size
                    if count>MAX_FILES or total>MAX_BYTES: fail('materialized inputs exceed aggregate bounds')
                    payload_hashes[port]=digest(encoded({'files':files,'directories':dirs}));hashes[port]=descriptor['ref']['sha256'] if 'ref' in descriptor else payload_hashes[port]
                    if 'ref' in descriptor: manifest_for(descriptor['ref'],state,store)
                files,dirs,_=inventory(tmp)
                if sorted(os.listdir(tmp))!=sorted(inputs): fail('undeclared materialized input')
                for port in inputs:
                    actual_files,actual_dirs,_=bounded_copy(os.path.join(tmp,port))
                    if digest(encoded({'files':actual_files,'directories':actual_dirs}))!=payload_hashes[port]: fail('consumer payload changed before publication')
                verify_task();verify_code()
                receipt={'sources':digest(encoded(inputs)),'inputHashes':hashes,'payloadHashes':payload_hashes,'files':files,'directories':dirs}
                atomic(marker,receipt,MAX_META)
                freeze_dirs(tmp);os.rename(tmp,target);syncdir(parent)
                return {'op':op,'inputHashes':hashes,'files':files}
            finally:
                if os.path.exists(tmp): writable_remove(tmp)
        fail('unsupported retention operation')
    finally:
        fcntl.flock(lock_fd,fcntl.LOCK_UN);os.close(lock_fd)
try:
    request=sys.stdin.buffer.read(STATE_BYTES+1)
    if len(request)>STATE_BYTES: fail('request bound exceeded')
    result=perform(json.loads(request))
    output=encoded(result)
    if len(output)>STATE_BYTES: fail('receipt bound exceeded')
    print(output.decode())
except Exception as error:
    message=str(error) if isinstance(error,ValueError) else 'retained filesystem operation failed'
    print(json.dumps({'error':message[:300]}))
    sys.exit(1)
`;
