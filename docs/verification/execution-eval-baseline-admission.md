# Baseline admission replay

This operator wrapper uses the workspace's existing remote_dev path/host-slot and load admission. It adds no new scheduler, worker or account path. The only container is the ordinary admitted development container, pinned to its actual local Docker image ID. The benchmark adapter never invokes Docker or SSH itself.

Save the following wrapper outside the code checkout, then run it with the workspace-configured Python (the same interpreter used for remote_dev):

```sh
python operator-wrapper.py "$WORKSPACE/_meta/scripts/remote_dev.py" "$CHECKOUT" > transport.log 2>&1
```

Use a clean committed checkout and a fresh container. Exit75 is a deferral, not a retry loop. Git objects come from the controller's already-admitted read-only local bare store; a shared exact-HEAD checkout avoids pack worker threads consuming the fixed32-PID budget. No code or method is modified. CPU/memory/PID/network settings are checked inside the adapter. Keep the transport log outside Git and import only the bounded hash-verified JSON bundle following `EXECUTION_BASELINE_BUNDLE `.

```python
"""Pin image/limits inside the existing remote_dev admission; does not create a second admission path."""
import importlib.util
import re
import shlex
import subprocess
import sys
from pathlib import Path

controller = Path(sys.argv[1]).resolve()
worktree = Path(sys.argv[2]).resolve()
sys.path.insert(0, str(controller.parent))
spec = importlib.util.spec_from_file_location('execution_baseline_remote_dev', controller)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_get, original_run = module._wsconfig.get, module.docker_run

def config(conf, key):
    value = original_get(conf, key)
    return {**value, 'cpus': 2, 'memory': '256m'} if key == 'tooling.remote_dev' else value

module._wsconfig.get = config
_, conf = module._wsconfig.load()
cfg = config(conf, 'tooling.remote_dev')
image = cfg['prefix'] + ':latest'
if not re.fullmatch(r'[A-Za-z0-9_.-]+:latest', image):
    raise SystemExit('unexpected configured admission image name')

def admitted(host, container, command):
    # This hook runs only after remote_dev acquired the normal path/host slots and passed load admission.
    token = shlex.quote(image)
    if command.count(token) != 1 or command.count('docker run --rm ') != 1:
        raise RuntimeError('unexpected admission command; refusing to launch')
    command = command.replace('docker run --rm ', 'docker run --rm --pids-limit 32 --network none -e EXECUTION_EVAL_IMAGE_DIGEST="$baseline_image" ', 1)
    command = command.replace(token, '"$baseline_image"', 1)
    start = command.find('git init -q /v/r && cd /v/r && git remote add origin /git/repo.git && ')
    marker = 'git checkout -q --detach refs/verify/target && '
    end = command.find(marker, start)
    if start < 0 or end < 0:
        raise RuntimeError('unexpected verify checkout; refusing to launch')
    commit = subprocess.check_output(['git', '-C', str(worktree), 'rev-parse', 'HEAD'], text=True).strip()
    if not re.fullmatch(r'[a-f0-9]{40}', commit):
        raise RuntimeError('invalid source commit')
    checkout = 'git -c pack.threads=1 -c index.threads=1 clone -q --shared --no-checkout /git/repo.git /v/r && cd /v/r && git -c index.threads=1 checkout -q --detach ' + commit + ' && '
    command = command[:start] + checkout + command[end+len(marker):]
    lookup = 'baseline_image=$(docker image inspect --format ' + shlex.quote('{{.Id}}') + ' ' + token + ') && '
    return original_run(host, container, lookup + command)

module.docker_run = admitted
sys.argv = [str(controller), 'verify', str(worktree), '--', 'bun --smol scripts/execution-eval.ts baseline /tmp/execution-baseline-receipts --emit']
raise SystemExit(module.main())
```

The wrapper first lets remote_dev acquire its normal locks and pass its normal host-load gate. Only at its existing container-launch hook does it read the configured image ID and pin the launch to that ID, instead of a mutable tag. It does not read or change account settings. Source comes from the exact admitted commit, and the receipt's independent clean-code hash check refuses any mismatch.

For the committed T2a run, two earlier preparation admissions failed before the baseline entry point: Git pack-objects could not allocate threads under32 PIDs. The first fetch-level thread setting did not propagate to upload-pack. The shared local checkout above resolved preparation without raising the budget. Both failed-admission log hashes/sizes and unknown costs are recorded separately in `execution-eval-baseline/baseline-3f8f373/admission-failures.json`; they are not fabricated case observations and are not erased from reporting. There was one completed baseline invocation. No treatment or Supervision invocation occurred.
