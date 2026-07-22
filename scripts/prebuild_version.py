# PlatformIO extra_script: erzeugt main/version.h aus version.txt, einem
# hochzaehlenden Build-Counter (.build_number) und dem git-Hash. Laeuft vor
# jedem Build. version.h und .build_number sind .gitignore't (Build-lokal).

Import("env")  # noqa: F821 - injiziert von PlatformIO

import os
import subprocess
from datetime import datetime

proj = env['PROJECT_DIR']  # noqa: F821


def _read(path, default=""):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return default


version = _read(os.path.join(proj, "version.txt"), "0.0.0") or "0.0.0"

# Build-Counter: bei jedem Build +1
bn_path = os.path.join(proj, ".build_number")
try:
    build = int(_read(bn_path, "0") or "0")
except ValueError:
    build = 0
build += 1
try:
    with open(bn_path, "w", encoding="utf-8") as f:
        f.write(str(build))
except OSError:
    pass

# git-Kurz-Hash (mit *-Suffix bei uncommitteten Aenderungen)
try:
    githash = subprocess.check_output(
        ["git", "rev-parse", "--short", "HEAD"], cwd=proj,
        stderr=subprocess.DEVNULL).decode().strip()
    dirty = subprocess.call(["git", "diff", "--quiet"], cwd=proj,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if dirty != 0:
        githash += "*"
except Exception:
    githash = "nogit"

date = datetime.now().strftime("%Y-%m-%d %H:%M")

hdr = os.path.join(proj, "main", "version.h")
content = (
    "#pragma once\n"
    "// AUTO-GENERATED von scripts/prebuild_version.py - nicht editieren.\n"
    '#define EUL_FW_VERSION "%s"\n' % version +
    "#define EUL_FW_BUILD   %d\n" % build +
    '#define EUL_FW_GIT     "%s"\n' % githash +
    '#define EUL_FW_DATE    "%s"\n' % date
)
# nur schreiben wenn sich (ausser Build/Datum) etwas aendert? Nein - Build zaehlt
# ja jedes Mal hoch, also immer schreiben.
with open(hdr, "w", encoding="utf-8") as f:
    f.write(content)

print("[version] v%s build %d (%s)" % (version, build, githash))
