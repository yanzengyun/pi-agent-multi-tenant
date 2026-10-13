"""Trusted child setup, isolated from the threaded HTTP server's Python state."""
import os
import resource
import sys
from pathlib import Path

Path(sys.argv[1], 'cgroup.procs').write_text(str(os.getpid()))
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
os.execv('/usr/bin/bwrap', sys.argv[2:])
