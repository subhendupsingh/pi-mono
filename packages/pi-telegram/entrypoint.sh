#!/bin/sh
# Entrypoint: write auth.json from AUTH_JSON env var if provided
# This lets you set credentials in Coolify's environment variables
# without needing SSH or a terminal.

if [ -n "$AUTH_JSON" ]; then
    echo "Writing auth.json from AUTH_JSON environment variable..."
    mkdir -p .pi
    echo "$AUTH_JSON" > .pi/auth.json
    echo "auth.json written successfully."
else
    echo "No AUTH_JSON env var found, using existing .pi/auth.json if present."
fi

# Hand off to the actual bot
exec node dist/main.js "$@"
