# Pi Telegram Assistant

An autonomous Telegram bot capable of coding, browsing, and email tasks.

## Setup

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment**:
   ```bash
   # Create .env for Telegram Token
   echo 'TELEGRAM_BOT_TOKEN="your_bot_token"' > .env
   ```

3. **Configure AI Providers**:
   Run the setup script to create templates in `~/.pi/mom/`:
   ```bash
   bash setup-auth.sh
   ```
   Then edit `~/.pi/mom/auth.json` to add your keys for `anthropic`, `kimi-coding`, and `google`.

4. **Run**:
   ```bash
   npm run dev
   ```

## Features

- **Coding**: Full bash access, file read/write/edit.
- **Browsing & Email**: Extensible via `pi-skills`.
- **Memory**: Persistent context via `data/MEMORY.md`.
- **Model Selection**: Change models on the fly with `/model <id>`.

## Commands

- `/start`: Initialize the assistant.
- `/model`: View current model.
- `/model <id>`: Change to a different model (e.g., `claude-3-5-sonnet-20241022`).
