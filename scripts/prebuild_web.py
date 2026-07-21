# PlatformIO extra_script: baut das TypeScript-Portal aus web/ in
# main/portal_html.h, bevor die Firmware kompiliert wird.
#
# Wenn web/ nicht existiert oder Node nicht installiert ist, wird die
# vorhandene main/portal_html.h benutzt (kein Fehler).

Import("env")  # noqa: F821 - injiziert von PlatformIO

import os
import shutil
import subprocess


def _run(cmd, cwd, label):
    print(f"[web] {label}: {' '.join(cmd)}")
    r = subprocess.run(cmd, cwd=cwd)
    return r.returncode == 0


project_dir = env['PROJECT_DIR']  # noqa: F821
web_dir = os.path.join(project_dir, 'web')

if not os.path.isdir(web_dir):
    print("[web] no web/ directory - using pre-generated main/portal_html.h")
else:
    node = shutil.which('node')
    npm = shutil.which('npm')
    if not node or not npm:
        print("[web] WARNING: node/npm not found - falling back to existing main/portal_html.h")
        print("[web]          install with: brew install node")
    else:
        if not os.path.isdir(os.path.join(web_dir, 'node_modules')):
            if not _run([npm, 'install'], web_dir, "installing deps"):
                print("[web] ERROR: npm install failed")
                env.Exit(1)  # noqa: F821

        if not _run([npm, 'run', 'build'], web_dir, "building portal"):
            print("[web] ERROR: build failed")
            env.Exit(1)  # noqa: F821
