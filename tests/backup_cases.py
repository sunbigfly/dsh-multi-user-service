import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('dsh_backup', Path(__file__).resolve().parent.parent / 'ops/backup.py')
backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(backup)

with tempfile.TemporaryDirectory(prefix='dsh-backup-test-') as temporary:
    root = Path(temporary); source = root / 'source'; source.mkdir()
    private = source / 'credentials'; private.write_bytes(b'synthetic-secret\x00\xff'); private.chmod(0o600)
    (source / 'nested').mkdir(); (source / 'nested/data.txt').write_text('synthetic member data')
    (source / 'nested').chmod(0o555)
    outside = root / 'canary'; outside.write_text('outside must be untouched')
    (source / 'link').symlink_to(outside)
    archives = root / 'backups'
    package = root / 'plugin.tgz'; package.write_bytes(b'synthetic package')
    package_info = {'name': '@sunbigfly/dsh-multi-user-service', 'filename': package.name}
    assert backup.packed_file(json.dumps([package_info]), root) == package
    assert backup.packed_file(json.dumps({'@sunbigfly/dsh-multi-user-service': package_info}), root) == package
    path, manifest = backup.create_snapshot([{'key': 'dsh', 'path': str(source)}], archives)
    assert path.stat().st_mode & 0o777 == 0o600
    assert archives.stat().st_mode & 0o777 == 0o700
    assert backup.verify_snapshot(path)['format'] == backup.FORMAT
    restored = root / 'restored'; backup.restore_snapshot(path, restored)
    assert (restored / 'scopes/dsh/credentials').read_bytes() == private.read_bytes()
    assert (restored / 'scopes/dsh/credentials').stat().st_mode & 0o777 == 0o600
    assert (restored / 'scopes/dsh/nested/data.txt').read_text() == 'synthetic member data'
    assert (restored / 'scopes/dsh/nested').stat().st_mode & 0o777 == 0o555
    assert os.readlink(restored / 'scopes/dsh/link') == str(outside)
    try: backup.restore_snapshot(path, source)
    except FileExistsError: pass
    else: raise AssertionError('existing data was replaced')
    assert outside.read_text() == 'outside must be untouched'
    bad = root / 'tampered.tar.gz'
    with tarfile.open(path, 'r:gz') as old, tarfile.open(bad, 'w:gz') as new:
        for item in old.getmembers():
            data = old.extractfile(item).read() if item.isfile() else None
            if item.name.endswith('/credentials'): data = b'x' * item.size
            new.addfile(item, io.BytesIO(data) if data is not None else None)
    try: backup.verify_snapshot(bad)
    except ValueError: pass
    else: raise AssertionError('corrupted bytes were accepted')
    traversal = root / 'traversal.tar.gz'
    with tarfile.open(traversal, 'w:gz') as archive:
        item = tarfile.TarInfo('../escape'); item.size = 1; archive.addfile(item, io.BytesIO(b'x'))
    try: backup.restore_snapshot(traversal, root / 'unsafe')
    except ValueError: pass
    else: raise AssertionError('traversal was accepted')
    unrelated = archives / 'keep.txt'; unrelated.write_text('not a backup')
    for number in range(8): backup.create_snapshot([{'key': 'dsh', 'path': str(source)}], archives, keep=7)
    assert len([p for p in archives.iterdir() if backup.ARCHIVE.fullmatch(p.name)]) == 7
    assert unrelated.read_text() == 'not a backup'
    path = max((p for p in archives.iterdir() if backup.ARCHIVE.fullmatch(p.name)), key=lambda p: p.stat().st_mtime_ns)
    # Exercise the same promotion path against synthetic roots only. The prior
    # version remains available through the private safety receipt.
    private.write_text('changed after backup')
    receipt = backup.restore_in_place(path, root / 'in-place-stage', root / 'receipts')
    assert private.read_bytes() == b'synthetic-secret\x00\xff'
    previous = Path(json.loads(receipt.read_text())['changes'][0]['previous'])
    assert (previous / 'credentials').read_text() == 'changed after backup'
    (source / 'nested').chmod(0o755); (restored / 'scopes/dsh/nested').chmod(0o755)
    (previous / 'nested').chmod(0o755); (root / 'in-place-stage/scopes/dsh/nested').chmod(0o755)
    print(json.dumps({'state': 'restored-and-verified', 'retained': 7, 'canaryUnchanged': True}))
