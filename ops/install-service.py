#!/usr/bin/env python3
"""Install user service definitions; installation never starts a second DSH."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import pwd
import re

def unit_path(path, command=False):
    value = str(path)
    if any(c in value for c in '\x00\r\n'):
        raise ValueError('Service paths cannot contain control characters')
    if not command:
        return value.replace('%', '%%')
    value = value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$')
    return '"' + value + '"'


def render_unit(template, root):
    return (template.replace('@DSH_LAN_ROOT@', unit_path(root))
            .replace('@DSH_LAN_SERVE@', unit_path(root / 'ops/serve.sh', True))
            .replace('@DSH_LAN_BACKUP@', unit_path(root / 'ops/backup.py', True)))


def render_startup(template, distribution, username, home):
    if not distribution or not username or any(c in distribution + username for c in '\x00\r\n'):
        raise ValueError('WSL distribution and username are required')
    command = subprocess.list2cmdline(['wsl.exe', '-d', distribution, '-u', username, '--exec', '/usr/bin/flock', '-n', str(home / '.local/share/dsh-lan/windows-keepalive.lock'), '/usr/bin/sleep', 'infinity'])
    return template.replace('@DSH_LAN_WSL_COMMAND@', command.replace('"', '""'))


def distribution_from_path(path):
    match = re.match(r'^\\\\(?:wsl\.localhost|wsl\$)\\([^\\]+)\\', path, re.IGNORECASE)
    return match.group(1) if match else None


def ensure_profile(root, profile):
    manifest = profile / 'package.json'
    if not manifest.exists():
        subprocess.run(['dsh', '--profile', 'lan', '--from-default-profile', 'web', '--dump-config'], check=True, stdout=subprocess.DEVNULL)
    package = json.loads(manifest.read_text())
    bundles = package.get('dsh', {}).get('profile', {}).get('bundles')
    if not isinstance(bundles, list):
        raise SystemExit('The existing lan profile is not a DSH profile; it was left unchanged. Select or repair the profile before installing.')
    name = json.loads((root / 'package.json').read_text())['name']
    legacy = {
        '@sunbigfly/dsh-multi-user-service': '@sunbigfly/dsh-lan-workspace',
    }.get(name)
    if legacy and (legacy in bundles or legacy in package.get('dependencies', {})):
        subprocess.run(['dsh', 'plugin', '--profile', 'lan', 'remove', '--config.ignore-scripts=true', legacy], check=True)
        package = json.loads(manifest.read_text())
        bundles = package['dsh']['profile']['bundles']
    module = profile / 'node_modules' / name
    if name not in bundles or not module.exists() or module.resolve() != root:
        subprocess.run(['dsh', 'plugin', '--profile', 'lan', 'add', '--ignore-scripts', str(root)], check=True)


def main():
    root = Path(__file__).resolve().parent.parent
    home = Path.home()
    startup = content = None
    distribution = os.environ.get('WSL_DISTRO_NAME')
    powershell = shutil.which('powershell.exe')
    if not distribution and powershell and shutil.which('wslpath'):
        distribution = distribution_from_path(subprocess.check_output(['wslpath', '-w', str(home)], text=True).strip())
    if distribution and powershell:
        path = subprocess.check_output([powershell, '-NoProfile', '-NonInteractive', '-Command', '[Environment]::GetFolderPath("Startup")'], text=True).strip()
        directory = Path(subprocess.check_output(['wslpath', '-u', path], text=True).strip())
        startup = directory / 'DSH-LAN.vbs'
        content = render_startup((root / 'ops/windows-startup.vbs').read_text(), distribution, pwd.getpwuid(os.getuid()).pw_name, home)
        if startup.exists():
            previous = startup.read_text()
            managed = previous.startswith("' DSH LAN managed Windows startup") or previous.startswith("' Per-user Windows startup starts the existing WSL systemd services")
            if previous != content and not managed:
                raise SystemExit('Unrecognized Windows startup entry; left untouched.')
    available = subprocess.run(['node', '-e', "require.resolve('zod')"], cwd=root, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not available:
        command = 'ci' if (root / 'package-lock.json').exists() else 'install'
        subprocess.run(['npm', command, '--ignore-scripts', '--no-audit', '--no-fund'], cwd=root, check=True)
    profile = home / '.dsh/profiles/lan'
    ensure_profile(root, profile)
    units = home / '.config/systemd/user'
    units.mkdir(parents=True, exist_ok=True)
    for name in ['dsh-lan.service', 'dsh-lan-backup.service', 'dsh-lan-backup.timer']:
        (units / name).write_text(render_unit((root / 'ops' / name).read_text(), root))
    state = home / '.local/share/dsh-lan'
    state.mkdir(mode=0o700, parents=True, exist_ok=True); state.chmod(0o700)
    binary = home / '.local/bin/dsh-lan'; binary.parent.mkdir(parents=True, exist_ok=True)
    previous = state / 'dsh-lan.before-service'
    if binary.exists() and not binary.is_symlink() and not previous.exists():
        shutil.copy2(binary, previous); previous.chmod(0o600)
    binary.write_text((root / 'ops/command.sh').read_text()); binary.chmod(0o755)
    backup_binary = home / '.local/bin/dsh-lan-backup'
    backup_binary.write_text('#!/usr/bin/env bash\nexec /usr/bin/python3 ' + __import__('shlex').quote(str(root / 'ops/backup.py')) + ' "$@"\n'); backup_binary.chmod(0o755)
    env = dict(os.environ, XDG_RUNTIME_DIR=f'/run/user/{os.getuid()}', DBUS_SESSION_BUS_ADDRESS=f'unix:path=/run/user/{os.getuid()}/bus')
    subprocess.run(['systemctl', '--user', 'daemon-reload'], env=env, check=True)
    subprocess.run(['systemctl', '--user', 'enable', 'dsh-lan.service'], env=env, check=True)
    subprocess.run(['systemctl', '--user', 'enable', '--now', 'dsh-lan-backup.timer'], env=env, check=True)
    if startup:
        startup.write_text(content)
    print(json.dumps({'installed': str(units / 'dsh-lan.service'), 'windowsStartup': str(startup) if startup else None, 'started': False}))


if __name__ == '__main__':
    main()
