#!/bin/bash

PI_MOM_DIR="$HOME/.pi/mom"
mkdir -p "$PI_MOM_DIR"

echo "Configuring $PI_MOM_DIR/auth.json..."
if [ ! -f "$PI_MOM_DIR/auth.json" ]; then
  cat > "$PI_MOM_DIR/auth.json" << 'EOF'
{
  "anthropic": { "type": "api_key", "key": "REPLACE_WITH_YOUR_KEY" },
  "kimi-coding": { "type": "api_key", "key": "REPLACE_WITH_YOUR_KEY" },
  "google": { "type": "api_key", "key": "REPLACE_WITH_YOUR_KEY" }
}
EOF
  chmod 600 "$PI_MOM_DIR/auth.json"
  echo "Created auth.json. Please edit it to add your actual keys."
else
  echo "auth.json already exists. Please ensure it has keys for 'anthropic', 'kimi-coding', and 'google'."
fi

echo "Configuring $PI_MOM_DIR/models.json..."
cat > "$PI_MOM_DIR/models.json" << 'EOF'
{
  "providers": {
    "kimi-coding": {
      "baseUrl": "https://api.moonshot.cn/v1",
      "api": "openai-completions",
      "apiKey": "KIMI_API_KEY",
      "models": [
        { "id": "kimi-k2-thinking", "name": "Kimi K2 Thinking", "reasoning": true }
      ]
    }
  }
}
EOF

echo "Setup complete. You can now use /model in Telegram to switch between models."
echo "Standard models like google/gemini-2.0-flash are built-in and just need a key in auth.json under 'google'."
