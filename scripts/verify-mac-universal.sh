#!/usr/bin/env bash
# Checks the universal macOS build that `electron-builder --mac` leaves in dist/:
#   - exactly one .dmg;
#   - node-pty's native files (pty.node, spawn-helper) hold both x86_64 and arm64;
#   - nothing is packaged under node-pty/bin (a single-arch cache that breaks the universal merge)
#     or node-pty/prebuilds/darwin-* (identical in both builds, never the files node-pty loads);
#   - node-pty loads from the app's own runtime and a pty runs `echo ok`, on arm64 and, when
#     Rosetta is there, on x64.
# Run from the repository root.
set -euo pipefail

app="dist/mac-universal/PACT.app"
pty_dir="$app/Contents/Resources/app.asar.unpacked/node_modules/node-pty"
bin="$app/Contents/MacOS/PACT"

fail() { echo "::error::$*"; exit 1; }

dmgs=(dist/*.dmg)
[ "${#dmgs[@]}" -eq 1 ] && [ -f "${dmgs[0]}" ] || fail "expected exactly one .dmg in dist/, found: ${dmgs[*]}"
echo "dmg: ${dmgs[0]}"

for f in build/Release/pty.node build/Release/spawn-helper; do
  archs=$(lipo -archs "$pty_dir/$f")
  echo "$f: $archs"
  echo "$archs" | grep -qw x86_64 && echo "$archs" | grep -qw arm64 || fail "$f is not universal: $archs"
done

for stray in "$pty_dir/bin" "$pty_dir"/prebuilds/darwin-*; do
  [ ! -e "$stray" ] || fail "$stray must not be packaged"
done

probe='
const pty = require(process.env.APP + "/Contents/Resources/app.asar/node_modules/node-pty");
let out = "";
const p = pty.spawn("/bin/sh", ["-c", "echo ok"], { cols: 80, rows: 24 });
p.onData((d) => (out += d));
p.onExit((e) => {
  console.log(process.arch + ": exit " + e.exitCode + " " + JSON.stringify(out));
  process.exit(e.exitCode === 0 && out.trim() === "ok" ? 0 : 1);
});
setTimeout(() => { console.log(process.arch + ": timeout"); process.exit(2); }, 10000);
'

for arch in arm64 x86_64; do
  if arch -"$arch" /usr/bin/true 2>/dev/null; then
    APP="$PWD/$app" ELECTRON_RUN_AS_NODE=1 arch -"$arch" "$bin" -e "$probe" || fail "node-pty does not open a pty on $arch"
  else
    echo "::notice::$arch cannot run on this machine (Rosetta missing?): node-pty not loaded on $arch"
  fi
done
