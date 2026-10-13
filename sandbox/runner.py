"""Local-only command runner: fixed policies, per-user disk pool, fresh namespaces."""
import ctypes
import ctypes.util
import errno
import http.server
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import socketserver
import subprocess
import tempfile
import threading
import time

UUID = re.compile(r'^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$')
OUTPUT_LIMIT = 32768


class Pool:
    def __init__(self, directory, size):
        self.directory = Path(directory)
        self.file = self.directory / 'owners.json'
        self.owners = json.loads(self.file.read_text()) if self.file.exists() else {}
        self.size = size
        if len(set(self.owners.values())) != len(self.owners) or any(not UUID.fullmatch(key) or not isinstance(slot, int) or not 0 <= slot < size for key, slot in self.owners.items()):
            raise RuntimeError('invalid_pool_ownership')
        for slot in range(size):
            if not os.path.ismount(self.directory / str(slot)):
                raise RuntimeError('pool_volume_not_mounted')

    def save(self):
        temporary = self.file.with_suffix('.tmp')
        temporary.write_text(json.dumps(self.owners))
        temporary.chmod(0o600)
        temporary.replace(self.file)

    def acquire(self, user_id):
        reused = user_id in self.owners
        if not reused:
            available = next((slot for slot in range(self.size) if slot not in self.owners.values()), None)
            if available is None:
                raise RuntimeError('sandbox_pool_full')
            # Assign only an empty slot; interrupted cleanup must not leak old files.
            work = self.directory / str(available) / 'work'
            if any(work.iterdir()):
                raise RuntimeError('unowned_pool_slot_not_empty')
            self.owners[user_id] = available
            self.save()
        work = self.directory / str(self.owners[user_id]) / 'work'
        work.chmod(0o700)
        return work, reused

    def release(self, user_id):
        if user_id not in self.owners:
            return
        work = self.directory / str(self.owners[user_id]) / 'work'
        work.chmod(0o700)
        for entry in work.iterdir():
            if not entry.is_symlink() and entry.is_dir():
                shutil.rmtree(entry)
            else:
                entry.unlink()
        del self.owners[user_id]
        self.save()


def seccomp_filter():
    lib = ctypes.CDLL(ctypes.util.find_library('seccomp'))
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.c_void_p]
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    context = lib.seccomp_init(0x7fff0000)  # ALLOW, with explicit syscall denials.
    if not context:
        raise RuntimeError('seccomp_init_failed')
    class Compare(ctypes.Structure):
        _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int), ('mask', ctypes.c_uint64), ('value', ctypes.c_uint64)]
    def deny(name, error=errno.EPERM, comparison=None):
        syscall = lib.seccomp_syscall_resolve_name(name.encode())
        if syscall >= 0 and lib.seccomp_rule_add_array(context, 0x50000 | error, syscall, int(comparison is not None), ctypes.byref(comparison) if comparison is not None else None) != 0:
            raise RuntimeError('seccomp_rule_failed')
    try:
        for name in ['socket', 'socketpair', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'bpf', 'userfaultfd',
                     'keyctl', 'add_key', 'request_key', 'unshare', 'setns', 'mount', 'umount2', 'pivot_root',
                     'fsopen', 'fsmount', 'fspick', 'fsconfig', 'move_mount', 'open_tree', 'open_by_handle_at',
                     'io_uring_setup', 'io_uring_enter', 'io_uring_register', 'mknod', 'mknodat']:
            deny(name)
        deny('clone3', errno.ENOSYS)  # libc can fall back to clone for normal threads.
        for flag in [0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000]:
            deny('clone', comparison=Compare(0, 7, flag, flag))
        file = tempfile.TemporaryFile()
        if lib.seccomp_export_bpf(context, file.fileno()) != 0:
            file.close()
            raise RuntimeError('seccomp_export_failed')
        file.seek(0)
        return file
    finally:
        lib.seccomp_release(context)


class Runner:
    def __init__(self, pool):
        self.pool = pool
        self.busy = threading.Lock()
        self.state_lock = threading.Lock()
        self.active = {}
        self.cancelled = {}
        cgroup_line = next(line for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
        self.cgroup = Path('/sys/fs/cgroup') / cgroup_line[3:].lstrip('/')
        supervisor = self.cgroup / 'supervisor'
        supervisor.mkdir(exist_ok=True)
        (supervisor / 'cgroup.procs').write_text(str(os.getpid()))
        (self.cgroup / 'cgroup.subtree_control').write_text('+cpu +memory +pids')
        self.filter = seccomp_filter()

    def cancel(self, user_id, request_id):
        key = (user_id, request_id)
        with self.state_lock:
            if key in self.active:
                self.active[key].set()
            else:
                self.cancelled = {k: t for k, t in self.cancelled.items() if t > time.monotonic() - 60}
                if len(self.cancelled) >= 64:
                    raise RuntimeError('cancel_limit')
                self.cancelled[key] = time.monotonic()

    def arguments(self, work, command):
        args = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session', '--cap-drop', 'ALL',
                '--clearenv', '--ro-bind', '/usr', '/usr', '--symlink', 'usr/bin', '/bin',
                '--symlink', 'usr/sbin', '/sbin', '--symlink', 'usr/lib', '/lib', '--symlink', 'usr/lib64', '/lib64',
                '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--dir', '/home', '--dir', '/etc',
                '--bind', str(work), '/work', '--chdir', '/work', '--setenv', 'HOME', '/work',
                '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'LANG', 'C.UTF-8',
                '--setenv', 'TZ', 'Asia/Shanghai', '--seccomp', str(self.filter.fileno()),
                '--', '/bin/bash', '--noprofile', '--norc', '-c', command]
        return args

    def execute(self, user_id, request_id, command, timeout=30):
        if not self.busy.acquire(blocking=False):
            raise RuntimeError('sandbox_busy')
        group = None
        process = None
        stop = threading.Event()
        started = time.monotonic()
        key = (user_id, request_id)
        try:
            work, reused = self.pool.acquire(user_id)
            group = self.cgroup / ('task-' + request_id)
            group.mkdir()
            for name, value in [('memory.max', str(192 * 1024 * 1024)), ('memory.swap.max', '0'),
                                ('pids.max', '64'), ('cpu.max', '50000 100000')]:
                (group / name).write_text(value)
            with self.state_lock:
                self.active[key] = stop
                if key in self.cancelled:
                    self.cancelled.pop(key)
                    stop.set()
            if stop.is_set():
                return {'stdout': '', 'stderr': '', 'exitCode': None, 'reason': 'cancelled', 'workspaceReused': reused}
            self.filter.seek(0)
            process = subprocess.Popen(['/usr/bin/python3', str(Path(__file__).with_name('task_entry.py')), str(group)] + self.arguments(work, command),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
                pass_fds=(self.filter.fileno(),), env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
            output = {'stdout': bytearray(), 'stderr': bytearray()}
            reason = 'completed'
            with selectors.DefaultSelector() as selector:
                for name in output:
                    pipe = getattr(process, name)
                    os.set_blocking(pipe.fileno(), False)
                    selector.register(pipe, selectors.EVENT_READ, name)
                while selector.get_map() or process.poll() is None:
                    if stop.is_set():
                        reason = 'cancelled'
                        break
                    if time.monotonic() - started >= timeout:
                        reason = 'timed_out'
                        break
                    for event, _ in selector.select(.05):
                        data = os.read(event.fileobj.fileno(), 4096)
                        if not data:
                            selector.unregister(event.fileobj)
                        else:
                            left = OUTPUT_LIMIT - sum(map(len, output.values()))
                            output[event.data].extend(data[:left])
                            if len(data) > left:
                                reason = 'output_limit'
                                break
                    if reason != 'completed' or process.poll() is not None:
                        break
            (group / 'cgroup.kill').write_text('1')
            process.wait(timeout=3)
            for name, data in output.items():
                remaining = getattr(process, name).read(OUTPUT_LIMIT - sum(map(len, output.values()))) or b''
                data.extend(remaining)
            if 'oom_kill 0' not in (group / 'memory.events').read_text():
                reason = 'memory_limit'
            return {**{name: bytes(data).decode('utf-8', errors='replace') for name, data in output.items()},
                    'exitCode': process.returncode, 'reason': reason, 'durationMs': round((time.monotonic() - started) * 1000),
                    'workspaceReused': reused, 'network': False}
        finally:
            with self.state_lock:
                self.active.pop(key, None)
            if group:
                (group / 'cgroup.kill').write_text('1')
            if process:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=3)
                process.stdout.close()
                process.stderr.close()
            if group:
                for _ in range(30):
                    try:
                        group.rmdir()
                        break
                    except OSError:
                        time.sleep(.01)
                else:
                    raise RuntimeError('sandbox_cleanup_failed')
            self.busy.release()


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log commands, bodies or user files.

    def do_POST(self):
        self.connection.settimeout(5)
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 32768:
                raise ValueError('invalid_body')
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError('invalid_body')
            runner = self.server.runner
            if self.path == '/status':
                result = {'ready': True, 'allocated': len(runner.pool.owners), 'capacity': runner.pool.size,
                          'active': bool(runner.active), 'network': False, 'memoryMiB': 192, 'diskMiB': 128}
            else:
                user_id = data.get('userId')
                if not isinstance(user_id, str) or not UUID.fullmatch(user_id):
                    raise ValueError('invalid_user')
                if self.path == '/release':
                    if not runner.busy.acquire(blocking=False):
                        raise RuntimeError('sandbox_busy')
                    try:
                        runner.pool.release(user_id)
                    finally:
                        runner.busy.release()
                    result = {'ok': True}
                else:
                    request_id = data.get('requestId')
                    if not isinstance(request_id, str) or not UUID.fullmatch(request_id):
                        raise ValueError('invalid_request')
                    if self.path == '/cancel':
                        runner.cancel(user_id, request_id)
                        result = {'ok': True}
                    elif self.path == '/execute':
                        command = data.get('command')
                        if not isinstance(command, str) or not command.strip() or len(command) > 8000:
                            raise ValueError('invalid_command')
                        result = runner.execute(user_id, request_id, command)
                    else:
                        raise ValueError('invalid_route')
            self.reply(200, result)
        except (ValueError, json.JSONDecodeError):
            self.reply(400, {'error': 'invalid_sandbox_request'})
        except RuntimeError as error:
            known = str(error) in ['sandbox_busy', 'sandbox_pool_full', 'cancel_limit']
            self.reply(409 if known else 503, {'error': str(error) if known else 'sandbox_unavailable'})
        except Exception:
            self.reply(503, {'error': 'sandbox_unavailable'})

    def reply(self, status, data):
        encoded = json.dumps(data, ensure_ascii=False).encode()
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == '__main__':
    os.umask(0o077)
    pool = Pool('/var/lib/pi-sandbox/slots', int(os.environ.get('PI_SANDBOX_POOL_SIZE', '8')))
    runner = Runner(pool)
    socket = Path('/run/pi-sandbox/runner.sock')
    socket.unlink(missing_ok=True)
    with Server(str(socket), Handler) as server:
        socket.chmod(0o660)
        server.runner = runner
        server.serve_forever(poll_interval=.2)
