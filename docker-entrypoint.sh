#!/bin/sh
set -e

# Bind-mounted ./data is created root-owned by Docker, and files copied in on the host keep
# their owner. SQLite silently opens a database it can't write read-only, so the DB file,
# its WAL/SHM sidecars and the directory (sidecars are created in it) must belong to bun.
if [ "$(id -u)" = 0 ]; then
  mkdir -p /app/data
  chown -R bun:bun /app/data
  exec su-exec bun "$@"
fi

exec "$@"
