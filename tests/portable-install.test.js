import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';

const execute = promisify(execFile);
test('installer renders each deployment root, WSL distribution and user without performing an installation', async () => {
  const code = `import runpy,json\nfrom pathlib import Path\nh=runpy.run_path('ops/install-service.py')\nr=Path('/srv/team workspace')\na=h['render_unit'](Path('ops/dsh-lan.service').read_text(),r)\nb=h['render_unit'](Path('ops/dsh-lan-backup.service').read_text(),r)\nc=h['render_startup'](Path('ops/windows-startup.vbs').read_text(),'Team Linux','operator',Path('/home/operator'))\nprint(json.dumps({'unit':a,'backup':b,'startup':c}))`;
  const { stdout } = await execute('python3', ['-c', code]), result = JSON.parse(stdout);
  assert.match(result.unit, /WorkingDirectory=\/srv\/team workspace\n/);
  assert.match(result.unit, /ExecStart=\/bin\/bash "\/srv\/team workspace\/ops\/serve.sh"/);
  assert.match(result.backup, /"\/srv\/team workspace\/ops\/backup.py" create --scheduled/);
  assert.match(result.startup, /-d ""Team Linux"" -u operator/);
  assert.match(result.startup, /\/home\/operator\/.local\/share\/dsh-lan\/windows-keepalive.lock/);
  assert.doesNotMatch(JSON.stringify(result), /sunbigfly|Ubuntu-22\.04|@DSH_LAN_/);
});
test('shipped deployment templates and README do not depend on the author machine', async () => {
  for (const path of ['ops/windows-startup.vbs', 'ops/dsh-lan.service', 'ops/dsh-lan-backup.service', 'README.md']) {
    const value = await readFile(path, 'utf8'); assert.doesNotMatch(value, /192\.168\.2\.5|Ubuntu-22\.04|\/home\/sunbigfly/, path);
  }
});
test('WSL installation can identify its own distribution from a UNC path without a login-shell variable', async () => {
  const code = "import runpy,json; h=runpy.run_path('ops/install-service.py'); print(json.dumps([h['distribution_from_path']('\\\\\\\\wsl.localhost\\\\Team Linux\\\\home\\\\operator'),h['distribution_from_path']('C:\\\\Users\\\\operator')]))";
  const { stdout } = await execute('python3', ['-c', code]); assert.deepEqual(JSON.parse(stdout), ['Team Linux', null]);
});
test('first install initializes a web profile, preserves existing profiles and activates the bundle through the native CLI', async () => {
  const code = `import runpy,tempfile,json
from pathlib import Path
from unittest.mock import patch
h=runpy.run_path('ops/install-service.py')
with tempfile.TemporaryDirectory() as d:
 root=Path(d)/'source';root.mkdir();(root/'package.json').write_text(json.dumps({'name':'@team/example'}))
 profile=Path(d)/'profiles/lan';calls=[]
 def run(args,**kwargs):
  calls.append(args)
  if '--from-default-profile' in args:
   profile.mkdir(parents=True);(profile/'package.json').write_text(json.dumps({'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-app-web']}}}))
 with patch('subprocess.run',run): h['ensure_profile'](root,profile)
 assert calls==[['dsh','--profile','lan','--from-default-profile','web','--dump-config'],['dsh','plugin','--profile','lan','add','--ignore-scripts',str(root)]]
 calls.clear();before=(profile/'package.json').read_bytes()
 with patch('subprocess.run',run): h['ensure_profile'](root,profile)
 assert len(calls)==1 and 'plugin' in calls[0] and (profile/'package.json').read_bytes()==before
 manifest={'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-app-web','@team/example']}}};(profile/'package.json').write_text(json.dumps(manifest))
 module=profile/'node_modules/@team/example';module.parent.mkdir(parents=True);module.symlink_to(root,target_is_directory=True);calls.clear()
 with patch('subprocess.run',run): h['ensure_profile'](root,profile)
 assert calls==[]
 (profile/'package.json').write_text('{"dependencies":{}}');before=(profile/'package.json').read_bytes()
 with patch('subprocess.run',run):
  try: h['ensure_profile'](root,profile);raise AssertionError('invalid profile accepted')
  except SystemExit: pass
 assert calls==[] and (profile/'package.json').read_bytes()==before
 print('verified')`;
  const { stdout } = await execute('python3', ['-c', code]); assert.match(stdout, /verified/);
});
test('rendered service units with space-containing installation roots pass the real systemd parser', { skip: process.platform !== 'linux' }, async () => {
  const code = `import runpy,tempfile,subprocess,os\nfrom pathlib import Path\nh=runpy.run_path('ops/install-service.py')\nwith tempfile.TemporaryDirectory(prefix='dsh unit-') as d:\n p=Path(d)/'portable-test.service'\n p.write_text(h['render_unit'](Path('ops/dsh-lan.service').read_text(),Path(d)))\n env=dict(os.environ,XDG_RUNTIME_DIR='/run/user/'+str(os.getuid()),DBUS_SESSION_BUS_ADDRESS='unix:path=/run/user/'+str(os.getuid())+'/bus')\n subprocess.run(['systemd-analyze','--user','verify',str(p)],env=env,check=True,capture_output=True)\n print('verified')`;
  const { stdout } = await execute('python3', ['-c', code]); assert.match(stdout, /verified/);
});
