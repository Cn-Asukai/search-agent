#!/bin/sh
set -eu

# Bind mounts overlay the image's node-owned dirs. Start as root, fix
# ownership on the writable paths, then drop to node before exec.

own_node() {
  path=$1
  if [ -e "$path" ]; then
    chown -R node:node "$path" 2>/dev/null || true
  fi
}

if [ "$(id -u)" = 0 ]; then
  mkdir -p /home/node/data /home/node/.local/share/opencode
  # sqlite lives here; do not recurse into sibling websearch cache
  chown node:node /home/node/data 2>/dev/null || true
  own_node /home/node/.local/share/opencode
  own_node /home/node/data/search-agent.sqlite
  own_node /home/node/data/search-agent.sqlite-wal
  own_node /home/node/data/search-agent.sqlite-shm
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi

exec "$@"
