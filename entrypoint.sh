#!/bin/bash
# Fix ownership of mounted volumes (they mount as root on Railway)
chown -R appuser:appuser /app/sessions /home/appuser/.claude 2>/dev/null || true

# Run the app as appuser
exec gosu appuser bun run server.js
