import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	type AuthStorage,
	convertToLlm,
	createExtensionRuntime,
	formatSkillsForPrompt,
	loadSkillsFromDir,
	type ModelRegistry,
	SessionManager as PiSessionManager,
	type ResourceLoader,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { syncLogToSessionManager, TelegramSettingsManager } from "./context.js";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelStore } from "./store.js";
import { createTelegramTools, setUploadFunction } from "./tools/index.js";

export interface TelegramContext {
	message: {
		text: string;
		user: string;
		userName?: string;
		chatId: string;
		ts: string;
		attachments: Array<{ local: string }>;
	};
	respond: (text: string, shouldLog?: boolean) => Promise<void>;
	replaceMessage: (text: string) => Promise<void>;
	respondInThread: (text: string) => Promise<void>;
	setTyping: (isTyping: boolean) => Promise<void>;
	uploadFile: (filePath: string, title?: string) => Promise<void>;
	setWorking: (working: boolean) => Promise<void>;
	deleteMessage: () => Promise<void>;
}

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunner {
	run(
		ctx: TelegramContext,
		store: ChannelStore,
		pendingMessages?: PendingMessage[],
	): Promise<{ stopReason: string; errorMessage?: string }>;
	abort(): void;
	compact(): Promise<{ summary: string; tokensBefore: number }>;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getMemory(chatDir: string, sessionDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (parent of chatDir)
	const workspaceMemoryPath = join(chatDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) parts.push(`### Global Workspace Memory\n${content}`);
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read chat-specific memory
	const chatMemoryPath = join(chatDir, "MEMORY.md");
	if (existsSync(chatMemoryPath)) {
		try {
			const content = readFileSync(chatMemoryPath, "utf-8").trim();
			if (content) parts.push(`### Chat-Specific Memory\n${content}`);
		} catch (error) {
			log.logWarning("Failed to read chat memory", `${chatMemoryPath}: ${error}`);
		}
	}

	// Read session-specific memory
	const sessionMemoryPath = join(sessionDir, "MEMORY.md");
	if (existsSync(sessionMemoryPath)) {
		try {
			const content = readFileSync(sessionMemoryPath, "utf-8").trim();
			if (content) parts.push(`### Session Memory\n${content}`);
		} catch (error) {
			log.logWarning("Failed to read session memory", `${sessionMemoryPath}: ${error}`);
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : "(no working memory yet)";
}

function loadBotSkills(chatDir: string, workspacePath: string, piDir: string): Skill[] {
	const skillMap = new Map<string, Skill>();
	const hostWorkspacePath = join(chatDir, ".."); // workingDir

	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(hostWorkspacePath)) {
			return workspacePath + hostPath.slice(hostWorkspacePath.length);
		}
		return hostPath;
	};

	// Skills from .pi/skills
	const piSkillsDir = join(piDir, "skills");
	if (existsSync(piSkillsDir)) {
		for (const skill of loadSkillsFromDir({ dir: piSkillsDir, source: "pi-config" }).skills) {
			skill.filePath = translatePath(skill.filePath);
			skill.baseDir = translatePath(skill.baseDir);
			skillMap.set(skill.name, skill);
		}
	}

	// Workspace-level skills
	const workspaceSkillsDir = join(hostWorkspacePath, "skills");
	if (existsSync(workspaceSkillsDir)) {
		for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
			skill.filePath = translatePath(skill.filePath);
			skill.baseDir = translatePath(skill.baseDir);
			skillMap.set(skill.name, skill);
		}
	}

	// Chat-level skills
	const chatSkillsDir = join(chatDir, "skills");
	if (existsSync(chatSkillsDir)) {
		for (const skill of loadSkillsFromDir({ dir: chatSkillsDir, source: "chat" }).skills) {
			skill.filePath = translatePath(skill.filePath);
			skill.baseDir = translatePath(skill.baseDir);
			skillMap.set(skill.name, skill);
		}
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	chatId: string,
	sessionTitle: string,
	sessionLogPath: string,
	sessionMemPath: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	skills: Skill[],
): string {
	const chatPath = `${workspacePath}/${chatId}`;
	const isDocker = sandboxConfig.type === "docker";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Bash working directory: / (use cd or absolute paths)
- Install tools with: apk add <package>
- Your changes persist across sessions`
		: `You are running directly on the host machine.
- Bash working directory: ${process.cwd()}
- Be careful with system modifications`;

	return `You are an autonomous Telegram bot assistant. Be concise. No emojis.

## Current Session
Title: "${sessionTitle}"

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Telegram Formatting (MarkdownV2)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: [text](url)
Use Markdown formatting in responses.

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── MEMORY.md                    # Global memory (all chats)
├── skills/                      # Global CLI tools you create
└── ${chatId}/                   # This chat
    ├── MEMORY.md                # Chat-specific memory
    ├── attachments/             # User-shared files
    ├── skills/                  # Chat-specific tools
    └── sessions/
        └── <session-id>/
            ├── context.jsonl    # This session's LLM context
            └── log.jsonl        # This session's message history
            └── MEMORY.md        # Session-specific memory

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${chatPath}/skills/<name>/\` (chat-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file.
\`\`\`json
{"type": "immediate", "chatId": "${chatId}", "text": "New event triggered"}
\`\`\`

**One-shot** - Triggers once at a specific time.
\`\`\`json
{"type": "one-shot", "chatId": "${chatId}", "text": "Reminder", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule.
\`\`\`json
{"type": "periodic", "chatId": "${chatId}", "text": "Check inbox", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames:
\`\`\`bash
cat > ${workspacePath}/events/reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "chatId": "${chatId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This suppresses the response.

### Limits
Maximum 5 events can be queued.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Chat (${chatPath}/MEMORY.md): chat-level ongoing work shared across sessions
- Session (${sessionMemPath}): decisions specific to this session/topic
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages
- Environment variables set
- Config files modified
- Skill dependencies installed

## Log Queries (for older history)
Your session log: \`${sessionLogPath}\`
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 ${sessionLogPath} | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" ${sessionLogPath} | jq -c '{date: .date[0:19], user: (.userName // .user), text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Telegram

Each tool requires a "label" parameter (shown to user).
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.substring(0, maxLen - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

// Cache runners per chatId:sessionId
const sessionRunners = new Map<string, AgentRunner>();

/**
 * Get or create an AgentRunner for a chat session.
 * Keyed by chatId:sessionId so switching sessions creates a fresh runner.
 */
export function getOrCreateRunner(
	sandboxConfig: SandboxConfig,
	chatId: string,
	chatDir: string,
	sessionId: string,
	sessionDir: string,
	sessionTitle: string,
	piDir: string,
	authStorage: AuthStorage,
	modelRegistry: ModelRegistry,
	getModelForChat: (chatId: string) => { provider: string; model: any },
): AgentRunner {
	const key = `${chatId}:${sessionId}`;
	const existing = sessionRunners.get(key);
	if (existing) return existing;

	const runner = createRunner(
		sandboxConfig,
		chatId,
		chatDir,
		sessionId,
		sessionDir,
		sessionTitle,
		piDir,
		authStorage,
		modelRegistry,
		getModelForChat,
	);
	sessionRunners.set(key, runner);
	return runner;
}

/** Drop the cached runner for a session (e.g. after delete). */
export function dropRunner(chatId: string, sessionId: string): void {
	sessionRunners.delete(`${chatId}:${sessionId}`);
}

/**
 * Create a new AgentRunner for a specific session.
 */
function createRunner(
	sandboxConfig: SandboxConfig,
	chatId: string,
	chatDir: string,
	sessionId: string,
	sessionDir: string,
	sessionTitle: string,
	piDir: string,
	authStorage: AuthStorage,
	modelRegistry: ModelRegistry,
	getModelForChat: (chatId: string) => { provider: string; model: any },
): AgentRunner {
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(join(chatDir, ".."));

	// Create tools
	const tools = createTelegramTools(executor);

	// Initial system prompt (chatDir holds memory/skills; sessionDir holds context)
	const memory = getMemory(chatDir, sessionDir);
	const skills = loadBotSkills(chatDir, workspacePath, piDir);
	const logPath = join(sessionDir, "log.jsonl");
	const sessMemPath = join(sessionDir, "MEMORY.md");
	const systemPrompt = buildSystemPrompt(
		workspacePath,
		chatId,
		sessionTitle,
		logPath,
		sessMemPath,
		memory,
		sandboxConfig,
		skills,
	);

	// Pi-coding-agent SessionManager (reads/writes context.jsonl)
	const contextFile = join(sessionDir, "context.jsonl");
	const piSessionManager = PiSessionManager.open(contextFile, sessionDir);
	const settingsManager = new TelegramSettingsManager(join(chatDir, ".."));

	// Create agent with initial model
	const { model: initialModel } = getModelForChat(chatId);
	const agent = new Agent({
		initialState: {
			systemPrompt,
			model: initialModel,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: async () => {
			const { provider } = getModelForChat(chatId);
			const key = await authStorage.getApiKey(provider);
			if (!key) {
				throw new Error(
					`No API key found for provider "${provider}" in auth.json.\n` + `Set an API key in .pi/auth.json`,
				);
			}
			return key;
		},
	});

	// Load existing messages for this session
	const loadedSession = piSessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.replaceMessages(loadedSession.messages);
		log.logInfo(`[${chatId}:${sessionId}] Loaded ${loadedSession.messages.length} messages`);
	}

	const resourceLoader: ResourceLoader = {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => [],
		getPathMetadata: () => new Map(),
		extendResources: () => {},
		reload: async () => {},
	};

	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

	// Create AgentSession wrapper
	const session = new AgentSession({
		agent,
		sessionManager: piSessionManager,
		settingsManager: settingsManager as any,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
	});

	// Mutable per-run state
	const runState = {
		ctx: null as TelegramContext | null,
		logCtx: null as { chatId: string; userName?: string } | null,
		queue: null as {
			enqueue(fn: () => Promise<void>, errorContext: string): void;
			enqueueMessage(text: string, target: "main" | "thread", errorContext: string, doLog?: boolean): void;
		} | null,
		pendingTools: new Map<string, { toolName: string; args: unknown; startTime: number }>(),
		totalUsage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		errorMessage: undefined as string | undefined,
	};

	// Subscribe to events ONCE
	session.subscribe(async (event) => {
		if (!runState.ctx || !runState.logCtx || !runState.queue) return;

		const { ctx, logCtx, queue, pendingTools } = runState;

		if (event.type === "tool_execution_start") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_start" };
			const args = agentEvent.args as { label?: string };
			const label = args.label || agentEvent.toolName;

			pendingTools.set(agentEvent.toolCallId, {
				toolName: agentEvent.toolName,
				args: agentEvent.args,
				startTime: Date.now(),
			});

			log.logToolStart(logCtx, agentEvent.toolName, label, agentEvent.args as Record<string, unknown>);
			queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
		} else if (event.type === "tool_execution_end") {
			const agentEvent = event as AgentEvent & { type: "tool_execution_end" };
			const resultStr = extractToolResultText(agentEvent.result);
			const pending = pendingTools.get(agentEvent.toolCallId);
			pendingTools.delete(agentEvent.toolCallId);

			const durationMs = pending ? Date.now() - pending.startTime : 0;

			if (agentEvent.isError) {
				log.logToolError(logCtx, agentEvent.toolName, durationMs, resultStr);
			} else {
				log.logToolSuccess(logCtx, agentEvent.toolName, durationMs, resultStr);
			}

			if (agentEvent.isError) {
				queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`, false), "tool error");
			}
		} else if (event.type === "message_start") {
			const agentEvent = event as AgentEvent & { type: "message_start" };
			if (agentEvent.message.role === "assistant") {
				log.logResponseStart(logCtx);
			}
		} else if (event.type === "message_end") {
			const agentEvent = event as AgentEvent & { type: "message_end" };
			if (agentEvent.message.role === "assistant") {
				const assistantMsg = agentEvent.message as any;

				if (assistantMsg.stopReason) {
					runState.stopReason = assistantMsg.stopReason;
				}
				if (assistantMsg.errorMessage) {
					runState.errorMessage = assistantMsg.errorMessage;
				}

				if (assistantMsg.usage) {
					runState.totalUsage.input += assistantMsg.usage.input;
					runState.totalUsage.output += assistantMsg.usage.output;
					runState.totalUsage.cacheRead += assistantMsg.usage.cacheRead;
					runState.totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
					runState.totalUsage.cost.input += assistantMsg.usage.cost.input;
					runState.totalUsage.cost.output += assistantMsg.usage.cost.output;
					runState.totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
					runState.totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
					runState.totalUsage.cost.total += assistantMsg.usage.cost.total;
				}

				const content = agentEvent.message.content;
				const thinkingParts: string[] = [];
				const textParts: string[] = [];
				for (const part of content) {
					if (part.type === "thinking") {
						thinkingParts.push((part as any).thinking);
					} else if (part.type === "text") {
						textParts.push((part as any).text);
					}
				}

				const text = textParts.join("\n");

				for (const thinking of thinkingParts) {
					log.logThinking(logCtx, thinking);
				}

				if (text.trim()) {
					log.logResponse(logCtx, text);
					queue.enqueueMessage(text, "main", "response main");
				}
			}
		} else if (event.type === "auto_compaction_start") {
			log.logInfo(`Auto-compaction started (reason: ${(event as any).reason})`);
			queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		} else if (event.type === "auto_compaction_end") {
			const compEvent = event as any;
			if (compEvent.result) {
				log.logInfo(`Auto-compaction complete: ${compEvent.result.tokensBefore} tokens compacted`);
			} else if (compEvent.aborted) {
				log.logInfo("Auto-compaction aborted");
			}
		} else if (event.type === "auto_retry_start") {
			const retryEvent = event as any;
			log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
			queue.enqueue(
				() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
				"retry",
			);
		}
	});

	// Telegram message limit
	const TELEGRAM_MAX_LENGTH = 4000;
	const splitForTelegram = (text: string): string[] => {
		if (text.length <= TELEGRAM_MAX_LENGTH) return [text];
		const parts: string[] = [];
		let remaining = text;
		let partNum = 1;
		while (remaining.length > 0) {
			const chunk = remaining.substring(0, TELEGRAM_MAX_LENGTH - 50);
			remaining = remaining.substring(TELEGRAM_MAX_LENGTH - 50);
			const suffix = remaining.length > 0 ? `\n_(continued ${partNum}...)_` : "";
			parts.push(chunk + suffix);
			partNum++;
		}
		return parts;
	};

	return {
		async compact() {
			const result = await session.compact();
			return { summary: result.summary, tokensBefore: result.tokensBefore };
		},

		async run(
			ctx: TelegramContext,
			_store: ChannelStore,
			_pendingMessages?: PendingMessage[],
		): Promise<{ stopReason: string; errorMessage?: string }> {
			await mkdir(sessionDir, { recursive: true });

			// Sync messages from log.jsonl into context
			const syncedCount = syncLogToSessionManager(piSessionManager, sessionDir, ctx.message.ts);
			if (syncedCount > 0) {
				log.logInfo(`[${chatId}:${sessionId}] Synced ${syncedCount} messages from log.jsonl`);
			}

			// Reload messages from context.jsonl
			const reloadedSession = piSessionManager.buildSessionContext();
			if (reloadedSession.messages.length > 0) {
				agent.replaceMessages(reloadedSession.messages);
				log.logInfo(`[${chatId}:${sessionId}] Reloaded ${reloadedSession.messages.length} messages`);
			}

			// Update model for this chat (could have changed via /model)
			const { model: currentModel } = getModelForChat(chatId);
			agent.setModel(currentModel);

			// Update system prompt with fresh memory and skills
			const memory = getMemory(chatDir, sessionDir);
			const skills = loadBotSkills(chatDir, workspacePath, piDir);
			const logPath = join(sessionDir, "log.jsonl");
			const sessMemPath = join(sessionDir, "MEMORY.md");
			const systemPrompt = buildSystemPrompt(
				workspacePath,
				chatId,
				sessionTitle,
				logPath,
				sessMemPath,
				memory,
				sandboxConfig,
				skills,
			);
			session.agent.setSystemPrompt(systemPrompt);

			// Set up file upload function
			setUploadFunction(async (filePath: string, title?: string) => {
				await ctx.uploadFile(filePath, title);
			});

			// Reset per-run state
			runState.ctx = ctx;
			runState.logCtx = {
				chatId: ctx.message.chatId,
				userName: ctx.message.userName,
			};
			runState.pendingTools.clear();
			runState.totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
			runState.stopReason = "stop";
			runState.errorMessage = undefined;

			// Create queue for this run
			let queueChain = Promise.resolve();
			runState.queue = {
				enqueue(fn: () => Promise<void>, errorContext: string): void {
					queueChain = queueChain.then(async () => {
						try {
							await fn();
						} catch (err) {
							const errMsg = err instanceof Error ? err.message : String(err);
							log.logWarning(`Telegram API error (${errorContext})`, errMsg);
						}
					});
				},
				enqueueMessage(text: string, _target: "main" | "thread", errorContext: string, _doLog = true): void {
					const parts = splitForTelegram(text);
					for (const part of parts) {
						this.enqueue(() => ctx.respond(part, _doLog), errorContext);
					}
				},
			};

			// Log context info
			log.logInfo(`Context sizes - system: ${systemPrompt.length} chars, memory: ${memory.length} chars`);

			// Build user message with timestamp and username prefix
			const now = new Date();
			const pad = (n: number) => n.toString().padStart(2, "0");
			const offset = -now.getTimezoneOffset();
			const offsetSign = offset >= 0 ? "+" : "-";
			const offsetHours = pad(Math.floor(Math.abs(offset) / 60));
			const offsetMins = pad(Math.abs(offset) % 60);
			const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offsetSign}${offsetHours}:${offsetMins}`;
			let userMessage = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;

			const imageAttachments: ImageContent[] = [];
			const nonImagePaths: string[] = [];

			for (const a of ctx.message.attachments || []) {
				const fullPath = `${workspacePath}/${a.local}`;
				const mimeType = getImageMimeType(a.local);

				if (mimeType && existsSync(fullPath)) {
					try {
						imageAttachments.push({
							type: "image",
							mimeType,
							data: readFileSync(fullPath).toString("base64"),
						});
					} catch {
						nonImagePaths.push(fullPath);
					}
				} else {
					nonImagePaths.push(fullPath);
				}
			}

			if (nonImagePaths.length > 0) {
				userMessage += `\n\n<attachments>\n${nonImagePaths.join("\n")}\n</attachments>`;
			}

			// Debug: write context to last_prompt.jsonl (in session dir)
			const debugContext = {
				systemPrompt,
				messages: session.messages,
				newUserMessage: userMessage,
				imageAttachmentCount: imageAttachments.length,
			};
			await writeFile(join(sessionDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

			await session.prompt(userMessage, imageAttachments.length > 0 ? { images: imageAttachments } : undefined);

			// Wait for queued messages
			await queueChain;

			// Handle error case
			if (runState.stopReason === "error" && runState.errorMessage) {
				try {
					await ctx.replaceMessage("_Sorry, something went wrong_");
					await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					log.logWarning("Failed to post error message", errMsg);
				}
			} else {
				// Final message update
				const messages = session.messages;
				const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
				const finalText =
					lastAssistant?.content
						.filter((c): c is { type: "text"; text: string } => c.type === "text")
						.map((c) => c.text)
						.join("\n") || "";

				// Check for [SILENT] marker
				if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
					try {
						await ctx.deleteMessage();
						log.logInfo("Silent response - deleted message");
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to delete message for silent response", errMsg);
					}
				} else if (finalText.trim()) {
					try {
						const mainText =
							finalText.length > TELEGRAM_MAX_LENGTH
								? `${finalText.substring(0, TELEGRAM_MAX_LENGTH - 50)}\n\n_(see next message for full response)_`
								: finalText;
						await ctx.replaceMessage(mainText);
					} catch (err) {
						const errMsg = err instanceof Error ? err.message : String(err);
						log.logWarning("Failed to replace message with final text", errMsg);
					}
				}
			}

			// Log usage summary
			if (runState.totalUsage.cost.total > 0) {
				const messages = session.messages;
				const lastAssistantMessage = messages
					.slice()
					.reverse()
					.find((m) => m.role === "assistant" && (m as any).stopReason !== "aborted") as any;

				const contextTokens = lastAssistantMessage
					? lastAssistantMessage.usage.input +
						lastAssistantMessage.usage.output +
						lastAssistantMessage.usage.cacheRead +
						lastAssistantMessage.usage.cacheWrite
					: 0;
				const contextWindow = currentModel.contextWindow || 200000;

				const summary = log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
				runState.queue.enqueue(() => ctx.respondInThread(summary), "usage summary");
				await queueChain;
			}

			// Clear run state
			runState.ctx = null;
			runState.logCtx = null;
			runState.queue = null;

			return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
		},

		abort(): void {
			session.abort();
		},
	};
}
