#!/bin/sh
# Entrypoint: seed .pi directory on first run, write auth.json from env var, start bot.

# Seed /app/.pi from the built-in image copy on first run.
# /app/.pi-stage is baked into the image (not overlaid by bind mount).
# We use 'cp -n' semantics: only copy files that don't already exist on the host,
# so user-created files and auth.json are never overwritten.
if [ -d "/app/.pi-stage" ]; then
    echo "Seeding .pi directory from image defaults..."
    mkdir -p /app/.pi

    # Copy each item from staging only if it doesn't exist at destination
    for item in /app/.pi-stage/*; do
        name=$(basename "$item")
        dest="/app/.pi/$name"
        if [ ! -e "$dest" ]; then
            cp -r "$item" "$dest"
            echo "  Seeded: $name"
        fi
    done

    echo "Seeding complete."
fi

# Write auth.json from AUTH_JSON env var if provided.
# Uses node to parse the JSON so that Coolify's escaped quotes (\") are handled correctly.
if [ -n "$AUTH_JSON" ]; then
    echo "Writing auth.json from AUTH_JSON environment variable..."
    mkdir -p /app/.pi
    node -e "
const fs = require('fs');
try {
    const parsed = JSON.parse(process.env.AUTH_JSON);
    fs.writeFileSync('/app/.pi/auth.json', JSON.stringify(parsed, null, 2));
    console.log('auth.json written successfully.');
} catch (e) {
    console.error('Failed to parse AUTH_JSON: ' + e.message);
    console.error('Make sure AUTH_JSON is valid JSON in Coolify environment variables.');
    process.exit(1);
}
"
else
    echo "No AUTH_JSON env var found, using existing /app/.pi/auth.json if present."
fi

# Hand off to the actual bot
exec node dist/main.js "$@"
