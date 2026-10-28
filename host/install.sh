#!/bin/bash
# Quiz Helper — registers the native messaging host with Chrome.
#
# What it does:
#   1. Picks a working python3.
#   2. Writes host.sh (a wrapper Chrome can launch) next to host.py.
#   3. Writes the host manifest into Chrome's NativeMessagingHosts folder,
#      allowing only this extension's ID (derived from manifest.json's key).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.sunbeam.quizhelper"

# --- 1. python3 -------------------------------------------------------------
PY=""
for cand in /usr/bin/python3 "$(command -v python3 || true)"; do
  [ -n "$cand" ] && [ -x "$cand" ] && "$cand" -c "import json,struct" 2>/dev/null && PY="$cand" && break
done
if [ -z "$PY" ]; then
  echo "error: no working python3 found" >&2
  exit 1
fi

# --- 2. wrapper script ------------------------------------------------------
cat > "$DIR/host.sh" <<EOF
#!/bin/bash
exec "$PY" "$DIR/host.py"
EOF
chmod +x "$DIR/host.sh" "$DIR/host.py"

# --- 3. extension id from manifest key --------------------------------------
KEY=$("$PY" -c "import json;print(json.load(open('$DIR/../extension/manifest.json'))['key'])")
EXT_ID=$(printf '%s' "$KEY" | base64 -d | shasum -a 256 | cut -c1-32 | tr '0-9a-f' 'a-p')

# --- 4. register with Chrome -------------------------------------------------
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$TARGET_DIR"
cat > "$TARGET_DIR/$HOST_NAME.json" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Quiz Helper — on-device Apple Foundation Model bridge",
  "path": "$DIR/host.sh",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"],
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

echo "✓ host registered for Chrome"
echo "  extension id : $EXT_ID"
echo "  python3      : $PY"
echo "  manifest     : $TARGET_DIR/$HOST_NAME.json"
echo
echo "Next steps:"
echo "  1. chrome://extensions → Developer mode → Load unpacked →"
echo "     $DIR/../extension"
echo "  2. (If the extension was already loaded, reload it.)"
