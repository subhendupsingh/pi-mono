#!/bin/sh
# Entrypoint: seed skills volume and write auth.json from env var.

# Seed .pi/skills from the built-in copy if the volume is empty or stale.
# The Dockerfile copies skills to /app/.pi-skills-stage/ so they survive the volume overlay.
if [ -d "/app/.pi-skills-stage" ]; then
    echo "Syncing skills into shared volume..."
    mkdir -p /app/.pi/skills
    cp -r /app/.pi-skills-stage/* /app/.pi/skills/ 2>/dev/null || true
    echo "Skills synced."
fi

# Write auth.json from AUTH_JSON env var if provided.
# Uses node to parse the JSON so that Coolify's escaped quotes (\") are handled correctly.
if [ -n "$AUTH_JSON" ]; then
    echo "Writing auth.json from AUTH_JSON environment variable..."
    mkdir -p .pi
    node -e "
const fs = require('fs');
try {
    // JSON.parse correctly handles both escaped (\") and clean (') JSON
    const parsed = JSON.parse(process.env.AUTH_JSON);
    fs.writeFileSync('.pi/auth.json', JSON.stringify(parsed, null, 2));
    console.log('auth.json written successfully.');
} catch (e) {
    console.error('Failed to parse AUTH_JSON: ' + e.message);
    console.error('Make sure AUTH_JSON is valid JSON in Coolify environment variables.');
    process.exit(1);
}
"
else
    echo "No AUTH_JSON env var found, using existing .pi/auth.json if present."
fi

# Hand off to the actual bot
exec node dist/main.js "$@"
