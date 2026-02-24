#!/bin/bash

# Configuration
VPS_USER="your-user"
VPS_HOST="your-vps-ip"
VPS_DIR="~/pi-telegram"

echo "🚀 Preparing deployment for pi-telegram..."

# 1. Clean local build artifacts to keep transfer small
# (Optional, but recommended)
# npm run clean

# 2. Sync files to VPS
# We sync the whole pi-mono root but only the needed packages
echo "📦 Transferring files to $VPS_HOST..."
rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude 'dist' \
    --exclude '.git' \
    --exclude 'packages/pi-telegram/data' \
    --exclude 'packages/pi-telegram/.pi' \
    ../../ \
    $VPS_USER@$VPS_HOST:$VPS_DIR

# 3. Create .env if it doesn't exist on VPS
echo "📝 Ensuring .env exists on VPS..."
ssh $VPS_USER@$VPS_HOST "cd $VPS_DIR/packages/pi-telegram && [ ! -f .env ] && echo 'TELEGRAM_BOT_TOKEN=' > .env || echo '.env already exists'"

echo "✅ Transfer complete."
echo ""
echo "Next steps on your VPS:"
echo "1. SSH into your VPS: ssh $VPS_USER@$VPS_HOST"
echo "2. Go to the project dir: cd $VPS_DIR/packages/pi-telegram"
echo "3. Edit .env with your token: nano .env"
echo "4. Copy your local .pi directory if needed"
echo "5. Start the bot: docker compose up -d --build"
echo ""
echo "Done!"
