#!/bin/sh
# Entrypoint: seed .pi directory on first run, write auth.json from env var, start bot.

# IMPORTANT: Inside the container, the .pi directory is ALWAYS at /app/.pi
# The PI_DIR env var is used for the HOST path (volume mount source), 
# but inside the container we always use /app/.pi
CONTAINER_PI_DIR="/app/.pi"

# The actual skills are nested: .pi/skills/pi-skills/
SKILLS_STAGE_DIR="/app/.pi-stage/skills/pi-skills"
SKILLS_DEST_DIR="$CONTAINER_PI_DIR/skills/pi-skills"

echo "=== Entrypoint Debug ==="
echo "Container PI_DIR: $CONTAINER_PI_DIR"
echo "Host PI_DIR (env var): '${PI_DIR:-(not set)}'"
echo "Skills stage dir: $SKILLS_STAGE_DIR"
echo "Skills dest dir: $SKILLS_DEST_DIR"

# Seed from .pi-stage to the actual .pi directory
# .pi-stage is baked into the image (not overlaid by bind mount).
if [ -d "/app/.pi-stage" ]; then
    echo ".pi-stage exists, checking structure:"
    find /app/.pi-stage -maxdepth 3 -type d | head -20
    
    echo "Ensuring PI_DIR exists: $CONTAINER_PI_DIR"
    mkdir -p "$CONTAINER_PI_DIR"
    
    echo "Current PI_DIR contents:"
    ls -la "$CONTAINER_PI_DIR" 2>/dev/null || echo "(empty or doesn't exist)"

    # First, copy any top-level items from .pi-stage (like auth.json template, etc.)
    echo "Copying top-level items from .pi-stage..."
    for item in /app/.pi-stage/*; do
        [ -e "$item" ] || continue
        name=$(basename "$item")
        dest="$CONTAINER_PI_DIR/$name"
        
        # Skip the 'skills' directory for now (handled separately)
        if [ "$name" = "skills" ]; then
            continue
        fi
        
        if [ ! -e "$dest" ]; then
            echo "  Seeding: $name"
            cp -r "$item" "$dest"
        else
            echo "  Skipped (exists): $name"
        fi
    done

    # Now handle skills merging: .pi-stage/skills/pi-skills/ -> .pi/skills/pi-skills/
    if [ -d "$SKILLS_STAGE_DIR" ]; then
        echo "Merging skills from $SKILLS_STAGE_DIR to $SKILLS_DEST_DIR..."
        mkdir -p "$SKILLS_DEST_DIR"
        
        echo "Skills in stage:"
        ls "$SKILLS_STAGE_DIR/"
        
        for skill in "$SKILLS_STAGE_DIR"/*; do
            [ -e "$skill" ] || continue
            
            skill_name=$(basename "$skill")
            skill_dest="$SKILLS_DEST_DIR/$skill_name"
            
            if [ ! -e "$skill_dest" ]; then
                echo "    Copying new skill: $skill_name"
                cp -r "$skill" "$skill_dest"
                echo "    Added skill: $skill_name"
            else
                echo "    Skill exists: $skill_name"
            fi
        done
    else
        echo "WARNING: Skills stage dir not found at $SKILLS_STAGE_DIR"
    fi

    echo "Seeding complete. Final PI_DIR structure:"
    find "$CONTAINER_PI_DIR" -maxdepth 3 -type d 2>/dev/null | head -20
else
    echo "WARNING: /app/.pi-stage does not exist!"
fi

echo "========================"

# Write auth.json from AUTH_JSON env var if provided.
# Uses node to parse the JSON so that Coolify's escaped quotes (\") are handled correctly.
if [ -n "$AUTH_JSON" ]; then
    echo "Writing auth.json from AUTH_JSON environment variable..."
    mkdir -p "$CONTAINER_PI_DIR"
    node -e "
const fs = require('fs');
try {
    const parsed = JSON.parse(process.env.AUTH_JSON);
    fs.writeFileSync('$CONTAINER_PI_DIR/auth.json', JSON.stringify(parsed, null, 2));
    console.log('auth.json written successfully to $CONTAINER_PI_DIR/auth.json');
} catch (e) {
    console.error('Failed to parse AUTH_JSON: ' + e.message);
    console.error('Make sure AUTH_JSON is valid JSON in Coolify environment variables.');
    process.exit(1);
}
"
else
    echo "No AUTH_JSON env var found, using existing $CONTAINER_PI_DIR/auth.json if present."
fi

# Hand off to the actual bot
echo "Starting bot with --pi-dir=$CONTAINER_PI_DIR"
exec node dist/main.js --pi-dir="$CONTAINER_PI_DIR" "$@"
