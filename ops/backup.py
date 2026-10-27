#!/usr/bin/env python3
"""Idle-only DSH snapshots and verified restoration, using the standard library."""
import argparse
import datetime as dt
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.request
import uuid
from zoneinfo import ZoneInfo

FORMAT = 'dsh-lan-backup/1'
HOME = Path.home()
REPO = Path(__file__).resolve().parent.parent
BACKUPS = HOME / '.local/share/dsh-lan-backups'
CONTROL = HOME / '.local/share/dsh-lan/backup.sock'
ARCHIVE = re.compile(r'dsh-lan-\d{8}T\d{6}Z-[a-f0-9]{8}\.tar\.gz')

def private_directory(path):
    path = Path(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink() or path.resolve() != path.absolute() or path.stat().st_uid != os.getuid():
        raise ValueError('A canonical directory owned by the current user is required')
    path.chmod(0o700)
    return path

def control(action, token=None, path=CONTROL):
    with socket.socket(socket.AF_UNIX) as peer:
        peer.settimeout(20)
        peer.connect(str(path))
        peer.sendall(json.dumps({'action': action, **({'token': token} if token else {})}).encode() + b'\n')
        data = b''
        while b'\n' not in data:
            chunk = peer.recv(8192)
            if not chunk or len(data) > 1024 * 1024: raise ValueError('Invalid backup control response')
            data += chunk
    result = json.loads(data)
    if not result.get('ok'): raise RuntimeError(result.get('error', 'Backup preparation failed'))
    return result

def service(*args):
    env = dict(os.environ, XDG_RUNTIME_DIR=f'/run/user/{os.getuid()}', DBUS_SESSION_BUS_ADDRESS=f'unix:path=/run/user/{os.getuid()}/bus')
    return subprocess.run(['systemctl', '--user', *args, 'dsh-lan.service'], env=env, check=True, capture_output=True, text=True)

def packed_file(output, directory):
    value = json.loads(output)
    rows = value if isinstance(value, list) else list(value.values()) if isinstance(value, dict) else []
    if len(rows) != 1 or not isinstance(rows[0], dict) or rows[0].get('name') != '@sunbigfly/dsh-multi-user-service': raise ValueError('Unexpected npm package metadata')
    name = rows[0].get('filename')
    if not isinstance(name, str) or Path(name).name != name or not name.endswith('.tgz'): raise ValueError('Invalid npm archive name')
    path = Path(directory) / name
    if not path.is_file() or path.is_symlink(): raise ValueError('npm did not produce a package archive')
    return path

def fingerprint(s):
    return s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns

def create_snapshot(roots, destination, package=None, keep=7):
    destination = private_directory(destination)
    if not 1 <= keep <= 365: raise ValueError('Retention must be between 1 and 365 snapshots')
    name = 'dsh-lan-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8] + '.tar.gz'
    partial = destination / ('.partial-' + name)
    manifest = {'format': FORMAT, 'createdAt': dt.datetime.now(dt.timezone.utc).isoformat(), 'uid': os.getuid(), 'roots': [], 'entries': [], 'excluded': []}
    keys = set()
    fd = os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as raw, tarfile.open(fileobj=raw, mode='w:gz', compresslevel=3) as archive:
            def add(path, name, key, relative=''):
                if path.name in ('node_modules', '.git', '__pycache__') or (key == 'dsh' and relative.split('/')[0] == 'logs') or (key == 'lan-state' and (path.name.endswith('.log') or path.name.endswith('.lock'))):
                    manifest['excluded'].append({'path': name, 'reason': 'dependency or runtime cache'}); return
                before = path.lstat()
                item = tarfile.TarInfo(name); item.mode = stat.S_IMODE(before.st_mode); item.mtime = int(before.st_mtime)
                row = {'path': name, 'mode': item.mode}
                if stat.S_ISDIR(before.st_mode):
                    item.type = tarfile.DIRTYPE; row['kind'] = 'directory'; archive.addfile(item); manifest['entries'].append(row)
                    children = sorted(path.iterdir())
                    for child in children: add(child, name + '/' + child.name, key, relative + '/' + child.name if relative else child.name)
                    if sorted(p.name for p in path.iterdir()) != [p.name for p in children]: raise RuntimeError('A directory changed during backup; snapshot discarded')
                elif stat.S_ISLNK(before.st_mode):
                    item.type = tarfile.SYMTYPE; item.linkname = os.readlink(path); row.update(kind='link', target=item.linkname)
                    archive.addfile(item); manifest['entries'].append(row)
                elif stat.S_ISREG(before.st_mode):
                    item.size = before.st_size; digest = hashlib.sha256()
                    class Reader:
                        def __init__(self, stream): self.stream = stream
                        def read(self, size):
                            value = self.stream.read(size); digest.update(value); return value
                    filefd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                    with os.fdopen(filefd, 'rb') as source:
                        if fingerprint(os.fstat(source.fileno())) != fingerprint(before): raise RuntimeError('A source file changed before backup')
                        archive.addfile(item, Reader(source))
                        if fingerprint(os.fstat(source.fileno())) != fingerprint(before): raise RuntimeError('A source file changed during backup')
                    row.update(kind='file', size=item.size, sha256=digest.hexdigest()); manifest['entries'].append(row)
                else:
                    manifest['excluded'].append({'path': name, 'reason': 'ephemeral socket or special file'}); return
                if fingerprint(path.lstat()) != fingerprint(before): raise RuntimeError('A source path changed during backup')
            for root in roots:
                key, path = root['key'], Path(root['path'])
                if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', key) or key in keys: raise ValueError('Invalid or duplicate backup scope')
                keys.add(key)
                if not path.is_absolute() or path.is_symlink() or path.resolve() != path: raise ValueError('A canonical source root is required')
                if destination.is_relative_to(path): raise ValueError('Backups cannot be inside a source scope')
                manifest['roots'].append({'key': key, 'path': str(path), 'present': path.exists()})
                if path.exists(): add(path, 'scopes/' + key, key)
            if package:
                add(Path(package), 'plugin/package.tgz', 'plugin')
                if (REPO / 'package-lock.json').is_file(): add(REPO / 'package-lock.json', 'plugin/package-lock.json', 'plugin')
            data = json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode()
            item = tarfile.TarInfo('manifest.json'); item.mode = 0o600; item.size = len(data); archive.addfile(item, io.BytesIO(data))
        with partial.open('rb') as file: os.fsync(file.fileno())
        verify_snapshot(partial)
        completed = destination / name
        os.rename(partial, completed)
        dirfd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
        try: os.fsync(dirfd)
        finally: os.close(dirfd)
        prune(destination, keep)
        return completed, manifest
    except BaseException:
        partial.unlink(missing_ok=True)
        raise

def safe_name(name):
    path = PurePosixPath(name)
    if not name or path.is_absolute() or '\\' in name or any(ord(c) < 32 for c in name) or any(p in ('.', '..') for p in name.split('/')) or str(path) != name:
        raise ValueError('Unsafe archive path')
    return path

def verify_snapshot(path):
    with tarfile.open(path, 'r:gz') as archive:
        members = archive.getmembers()
        names = {}
        for item in members:
            safe_name(item.name)
            if item.name in names or not (item.isfile() or item.isdir() or item.issym()): raise ValueError('Duplicate or unsupported archive entry')
            names[item.name] = item
        header = names.get('manifest.json')
        if not header or not header.isfile() or header.size > 64 * 1024 * 1024: raise ValueError('Invalid backup manifest')
        manifest = json.load(archive.extractfile(header))
        if manifest.get('format') != FORMAT: raise ValueError('Unsupported backup format')
        records = {row['path']: row for row in manifest['entries']}
        if len(records) != len(manifest['entries']) or set(records) != set(names) - {'manifest.json'}: raise ValueError('Backup inventory mismatch')
        links = {name for name, item in names.items() if item.issym()}
        for name, row in records.items():
            item = names[name]
            if any(str(parent) in links for parent in safe_name(name).parents): raise ValueError('Archive traverses a symlink')
            if item.mode != row['mode']: raise ValueError('Backup permissions mismatch')
            if row['kind'] == 'file' and item.isfile():
                digest = hashlib.sha256()
                with archive.extractfile(item) as source:
                    for chunk in iter(lambda: source.read(1024 * 1024), b''): digest.update(chunk)
                if item.size != row['size'] or digest.hexdigest() != row['sha256']: raise ValueError('Backup checksum mismatch')
            elif row['kind'] == 'directory' and item.isdir(): pass
            elif row['kind'] == 'link' and item.issym() and item.linkname == row['target']: pass
            else: raise ValueError('Backup entry type mismatch')
        for root in manifest['roots']:
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', root['key']) or not Path(root['path']).is_absolute(): raise ValueError('Invalid scope in manifest')
        return manifest

def restore_snapshot(path, destination):
    manifest = verify_snapshot(path)
    destination = Path(destination).absolute()
    if destination.exists() or destination.is_symlink(): raise FileExistsError('Restore destination must be new; existing data is never replaced')
    destination.mkdir(mode=0o700, parents=True)
    try:
        with tarfile.open(path, 'r:gz') as archive:
            members = archive.getmembers()
            directories = []
            # Materialize links last. Even absolute member links cannot redirect extraction.
            for item in sorted(members, key=lambda m: (m.issym(), len(PurePosixPath(m.name).parts), m.name)):
                target = destination.joinpath(*safe_name(item.name).parts)
                target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                if item.isdir():
                    target.mkdir(mode=0o700, exist_ok=True); directories.append((target, item.mode))
                elif item.issym(): os.symlink(item.linkname, target)
                else:
                    fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                    with os.fdopen(fd, 'wb') as output, archive.extractfile(item) as source:
                        shutil.copyfileobj(source, output, 1024 * 1024); output.flush(); os.fsync(output.fileno())
                if item.isfile(): target.chmod(item.mode & 0o777)
            for target, mode in reversed(directories): target.chmod(mode & 0o777)
        return manifest
    except BaseException:
        # A failed restore is kept for inspection, never promoted to live data.
        raise

def prune(directory, keep):
    files = sorted((p for p in directory.iterdir() if p.is_file() and not p.is_symlink() and ARCHIVE.fullmatch(p.name)), key=lambda p: p.stat().st_mtime_ns, reverse=True)
    for path in files[keep:]: path.unlink()

def restore_in_place(path, destination, receipt_directory=BACKUPS):
    """Explicit promotion only. Old roots are renamed, never destroyed."""
    manifest = restore_snapshot(path, destination)
    if manifest['uid'] != os.getuid(): raise ValueError('In-place restore requires the original service user')
    scopes = [(Path(root['path']), Path(destination) / 'scopes' / root['key']) for root in manifest['roots'] if root['present']]
    if len({target for target, _ in scopes}) != len(scopes): raise ValueError('Duplicate restore target')
    if any(a != b and (a.is_relative_to(b) or b.is_relative_to(a)) for a, _ in scopes for b, _ in scopes): raise ValueError('Overlapping restore scopes require manual review')
    for target, _ in scopes:
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        if target.parent.resolve() != target.parent or target.is_symlink(): raise ValueError('In-place restore requires canonical target paths')
    receipt_directory = private_directory(receipt_directory)
    tag = 'before-restore-' + dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    receipt = receipt_directory / (tag + '.json')
    changes = []
    def save_receipt(state):
        receipt.write_text(json.dumps({'state': state, 'archive': str(path), 'changes': changes}, indent=2)); receipt.chmod(0o600)
    def copy_new(source, target):
        mode = stat.S_IMODE(source.lstat().st_mode)
        if source.is_symlink(): os.symlink(os.readlink(source), target)
        elif source.is_dir():
            target.mkdir(mode=0o700)
            for item in source.iterdir(): copy_new(item, target / item.name)
            target.chmod(mode & 0o777)
        else:
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as output, source.open('rb') as input:
                shutil.copyfileobj(input, output, 1024 * 1024); output.flush(); os.fsync(output.fileno())
            target.chmod(mode & 0o777)
    try:
        save_receipt('started')
        for target, source in scopes:
            previous = target.with_name(target.name + '.' + tag)
            if previous.exists() or previous.is_symlink(): raise FileExistsError('Restore safety destination already exists')
            change = {'target': str(target), 'previous': str(previous) if target.exists() else None, 'installed': False}
            changes.append(change); save_receipt('started')
            if target.exists(): os.rename(target, previous)
            copy_new(source, target); change['installed'] = True; save_receipt('started')
        save_receipt('complete'); return receipt
    except BaseException:
        for change in reversed(changes):
            target, previous = Path(change['target']), Path(change['previous']) if change['previous'] else None
            if previous and previous.exists():
                if target.exists() or target.is_symlink(): os.rename(target, target.with_name(target.name + '.failed-' + tag))
                os.rename(previous, target)
        save_receipt('rolled-back'); raise

def live_backup(destination, scheduled=False):
    destination = private_directory(destination)
    with (destination / '.backup.lock').open('a') as lock:
        try: fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: return {'skipped': 'another backup is running'}
        if scheduled:
            today = dt.datetime.now(ZoneInfo('Asia/Shanghai')).date()
            if any(ARCHIVE.fullmatch(p.name) and dt.datetime.fromtimestamp(p.stat().st_mtime, ZoneInfo('Asia/Shanghai')).date() == today for p in destination.iterdir() if p.is_file()): return {'skipped': 'already backed up today'}
        prepared = control('prepare')
        if not prepared.get('ready'): return {'skipped': 'DSH has active work; a later timer run will retry'}
        stopped = False
        try:
            stopped = True; service('stop')
            roots = prepared['roots']
            for name in ['dsh-lan.service', 'dsh-lan-backup.service', 'dsh-lan-backup.timer']:
                roots.append({'key': name.replace('.', '-'), 'path': str(HOME / '.config/systemd/user' / name)})
            roots.append({'key': 'launcher', 'path': str(HOME / '.local/bin/dsh-lan')})
            with tempfile.TemporaryDirectory(prefix='.package-', dir=destination) as stage:
                result = subprocess.run(['npm', 'pack', '--ignore-scripts', '--json', '--pack-destination', stage], cwd=REPO, check=True, capture_output=True, text=True)
                package = packed_file(result.stdout, stage)
                path, manifest = create_snapshot(roots, destination, package=package)
            return {'backup': str(path), 'scopes': len(manifest['roots']), 'entries': len(manifest['entries']), 'keep': 7}
        finally:
            if stopped:
                service('start')
                origin = None
                for line in (CONTROL.parent / 'member-origin.yml').read_text().splitlines():
                    if line.strip().startswith('memberOrigin:'): origin = json.loads(line.split(':', 1)[1].strip())
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
                for attempt in range(45):
                    try:
                        if origin and opener.open(origin + '/lan/', timeout=2).status == 200: break
                    except OSError: pass
                    time.sleep(1)
                else: raise RuntimeError('Backup ended but DSH has not resumed; inspect dsh-lan.service')
            else:
                try: control('release', prepared.get('token'))
                except (OSError, RuntimeError): pass

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    backup = commands.add_parser('create', help='Back up the existing service only when idle')
    backup.add_argument('--directory', type=Path, default=BACKUPS); backup.add_argument('--scheduled', action='store_true')
    verify = commands.add_parser('verify'); verify.add_argument('archive', type=Path)
    restore = commands.add_parser('restore', help='Restore and verify into a NEW directory; live data is not replaced')
    restore.add_argument('archive', type=Path); restore.add_argument('--destination', type=Path, required=True)
    restore.add_argument('--in-place', action='store_true', help='Explicitly restore original paths with safety copies; stop DSH first')
    args = parser.parse_args()
    if args.command == 'create': result = live_backup(args.directory, args.scheduled)
    elif args.command == 'verify':
        value = verify_snapshot(args.archive); result = {'verified': True, 'entries': len(value['entries']), 'scopes': len(value['roots'])}
    else:
        if args.in_place:
            # The timer never calls this branch. Refuse all installed DSH
            # processes, including a manually launched profile outside systemd.
            for entry in Path('/proc').glob('[0-9]*/cmdline'):
                try: argv = entry.read_bytes().split(b'\0')
                except (PermissionError, FileNotFoundError, ProcessLookupError): continue
                if any(Path(os.fsdecode(arg)).name == 'dsh' for arg in argv[:2]): raise ValueError('Stop DSH before in-place restoration')
            receipt = restore_in_place(args.archive, args.destination)
            result = {'restoredInPlace': True, 'safetyReceipt': str(receipt), 'serviceStarted': False}
        else:
            value = restore_snapshot(args.archive, args.destination); result = {'restored': str(args.destination), 'entries': len(value['entries']), 'liveDataChanged': False}
    print(json.dumps(result, ensure_ascii=False))

if __name__ == '__main__':
    try: main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, tarfile.TarError) as error:
        raise SystemExit(f'Backup operation failed: {type(error).__name__}: {error}')
