#!/usr/bin/env node

import * as dotenv from "dotenv";
import { resolve } from "path";
import { TelegramBot } from "./bot.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";

dotenv.config();

// ============================================================================
// Config
// ============================================================================

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	piDir?: string;
	sandbox: SandboxConfig;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;
	let piDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (arg.startsWith("--pi-dir=")) {
			piDir = arg.slice("--pi-dir=".length);
		} else if (arg === "--pi-dir") {
			piDir = args[++i];
		} else if (arg === "--help" || arg === "-h") {
			console.log(`Usage: pi-telegram [options] <working-directory>

Options:
  --sandbox=host|docker:<name>    Execution sandbox (default: host)
  --pi-dir=<path>                 Path to .pi config directory (default: ./.pi)
  -h, --help                      Show this help

Environment:
  TELEGRAM_BOT_TOKEN              Telegram bot token (required)

The .pi directory should contain:
  auth.json                       API keys for AI providers
  models.json                     Custom model configurations (optional)
  skills/                         Skills loaded for all chats

Examples:
  pi-telegram ./data
  pi-telegram --pi-dir=~/.pi ./data
  pi-telegram --sandbox=docker:my-container ./data
`);
			process.exit(0);
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		piDir: piDir ? resolve(piDir) : undefined,
		sandbox,
	};
}

const parsedArgs = parseArgs();

// Require working dir
if (!parsedArgs.workingDir) {
	console.error("Usage: pi-telegram [--sandbox=host|docker:<name>] [--pi-dir=<path>] <working-directory>");
	process.exit(1);
}

if (!TELEGRAM_BOT_TOKEN) {
	console.error("Missing environment variable: TELEGRAM_BOT_TOKEN");
	console.error("Set it in .env or your shell.");
	process.exit(1);
}

const { workingDir, sandbox, piDir } = {
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	piDir: parsedArgs.piDir || resolve(".pi"),
};

await validateSandbox(sandbox);

// ============================================================================
// Start
// ============================================================================

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, workingDir, piDir, sandbox);

// Handle shutdown
process.on("SIGINT", () => {
	log.logInfo("Shutting down...");
	bot.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	log.logInfo("Shutting down...");
	bot.stop();
	process.exit(0);
});

bot.start().catch((err) => {
	log.error(`Bot failed to start: ${err}`);
	process.exit(1);
});
