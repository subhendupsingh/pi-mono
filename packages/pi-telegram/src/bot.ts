import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import { Bot, InlineKeyboard, InputFile } from "grammy";
import { join, resolve } from "path";
import type { TelegramContext } from "./agent.js";
import { type AgentRunner, dropRunner, getOrCreateRunner } from "./agent.js";
import { createEventsWatcher, type EventsWatcher, type EventTarget } from "./events.js";
import * as log from "./log.js";
import type { SandboxConfig } from "./sandbox.js";
import { escapeMarkdown, formatSessionsList, generateTitle, SessionManager, type SessionMeta } from "./sessions.js";
import { ChannelStore } from "./store.js";

// ============================================================================
// Types
// ============================================================================

export interface TelegramEvent {
	chatId: string;
	ts: string;
	user: string;
	userName?: string;
	text: string;
	attachments?: Array<{ local: string }>;
}

// ============================================================================
// Per-channel queue for sequential processing
// ============================================================================

type QueuedWork = () => Promise<void>;

class ChannelQueue {
	private queue: QueuedWork[] = [];
	private processing = false;

	enqueue(work: QueuedWork): void {
		this.queue.push(work);
		this.processNext();
	}

	size(): number {
		return this.queue.length;
	}

	private async processNext(): Promise<void> {
		if (this.processing || this.queue.length === 0) return;
		this.processing = true;
		const work = this.queue.shift()!;
		try {
			await work();
		} catch (err) {
			log.logWarning("Queue error", err instanceof Error ? err.message : String(err));
		}
		this.processing = false;
		this.processNext();
	}
}

// ============================================================================
// TelegramBot
// ============================================================================

export class TelegramBot implements EventTarget {
	private bot: Bot;
	private workingDir: string;
	private piDir: string;
	private authStorage: AuthStorage;
	private modelRegistry: ModelRegistry;
	private sandboxConfig: SandboxConfig;
	private store: ChannelStore;
	private eventsWatcher: EventsWatcher;
	private sessionManager: SessionManager;

	// Per-channel state
	private channelModels = new Map<string, string>();
	private channelStates = new Map<
		string,
		{
			running: boolean;
			runner: AgentRunner;
			stopRequested: boolean;
			sessionId: string;
		}
	>();
	private queues = new Map<string, ChannelQueue>();
	private deleteSelections = new Map<string, Set<string>>(); // chatId -> set of sessionId to delete

	constructor(token: string, workingDir: string, piDir: string, sandboxConfig: SandboxConfig = { type: "host" }) {
		this.bot = new Bot(token);
		this.workingDir = resolve(workingDir);
		this.piDir = resolve(piDir);
		this.sandboxConfig = sandboxConfig;

		this.authStorage = AuthStorage.create(join(this.piDir, "auth.json"));
		this.modelRegistry = new ModelRegistry(this.authStorage, join(this.piDir, "models.json"));

		this.store = new ChannelStore({ workingDir: this.workingDir });
		this.eventsWatcher = createEventsWatcher(this.workingDir, this);
		this.sessionManager = new SessionManager(this.workingDir);

		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}

		this.setupHandlers();
	}

	// ==========================================================================
	// Event Target Interface (for EventsWatcher)
	// ==========================================================================

	enqueueEvent(chatId: string, text: string): boolean {
		const queue = this.getQueue(chatId);
		if (queue.size() >= 5) {
			log.logWarning(`Event queue full for ${chatId}`);
			return false;
		}

		const event: TelegramEvent = {
			chatId,
			ts: Date.now().toString(),
			user: "EVENT",
			text,
		};

		queue.enqueue(() => this.handleEvent(event, true));
		return true;
	}

	// ==========================================================================
	// Private - Queue / Channel State
	// ==========================================================================

	private getQueue(chatId: string): ChannelQueue {
		let queue = this.queues.get(chatId);
		if (!queue) {
			queue = new ChannelQueue();
			this.queues.set(chatId, queue);
		}
		return queue;
	}

	private getOrCreateSessionRunner(chatId: string, session: SessionMeta): AgentRunner {
		const chatDir = join(this.workingDir, chatId);
		const sessDir = this.sessionManager.getSessionDir(chatId, session.id);

		return getOrCreateRunner(
			this.sandboxConfig,
			chatId,
			chatDir,
			session.id,
			sessDir,
			session.title,
			this.piDir,
			this.authStorage,
			this.modelRegistry,
			(id) => this.getModelForChat(id),
		);
	}

	private getChannelState(chatId: string) {
		const session = this.sessionManager.getOrCreateActiveSession(chatId);
		const runner = this.getOrCreateSessionRunner(chatId, session);

		let state = this.channelStates.get(chatId);
		if (!state || state.sessionId !== session.id) {
			state = { running: false, runner, stopRequested: false, sessionId: session.id };
			this.channelStates.set(chatId, state);
		} else {
			// Keep runner up-to-date if session unchanged
			state.runner = runner;
		}
		return { state, session };
	}

	private getModelForChat(chatId: string): { provider: string; model: any } {
		this.modelRegistry.refresh();
		const modelFullId = this.channelModels.get(chatId);

		if (modelFullId) {
			const parts = modelFullId.split("/");
			if (parts.length === 2) {
				const found = this.modelRegistry.find(parts[0], parts[1]);
				if (found) return { provider: parts[0], model: found };
			}
		}

		const available = this.modelRegistry.getAvailable();
		if (available.length > 0) return { provider: available[0].provider, model: available[0] };

		throw new Error("No models configured. Add API keys to .pi/auth.json.\n" + "Use /model to see available models.");
	}

	// ==========================================================================
	// Private - Logging
	// ==========================================================================

	private logToFile(chatId: string, sessionId: string, entry: object): void {
		const logPath = this.sessionManager.getLogPath(chatId, sessionId);
		const dir = this.sessionManager.getSessionDir(chatId, sessionId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
	}

	private logBotResponse(chatId: string, sessionId: string, text: string, ts: string): void {
		this.logToFile(chatId, sessionId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	private logUserMessage(chatId: string, sessionId: string, userName: string, text: string, ts: string): void {
		this.logToFile(chatId, sessionId, {
			date: new Date(parseInt(ts, 10)).toISOString(),
			ts,
			user: userName,
			userName,
			text,
			attachments: [],
			isBot: false,
		});
	}

	// ==========================================================================
	// Private - Event Handling
	// ==========================================================================

	private async handleEvent(event: TelegramEvent, isScheduledEvent?: boolean): Promise<void> {
		const { state, session } = this.getChannelState(event.chatId);
		state.running = true;
		state.stopRequested = false;

		log.logInfo(`[${event.chatId}:${session.id}] Starting run: ${event.text.substring(0, 50)}`);

		// Auto-set title on first real message
		if (session.title === "New session" && session.messageCount === 0 && !isScheduledEvent) {
			const title = generateTitle(event.text);
			this.sessionManager.updateSessionTitle(event.chatId, session.id, title);
			session.title = title;
		}

		try {
			const ctx = this.createTelegramContext(event, session, isScheduledEvent);
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx, this.store);
			await ctx.setWorking(false);

			// Touch + log
			this.sessionManager.touchSession(event.chatId, session.id);

			if (result.stopReason === "aborted" && state.stopRequested) {
				await this.bot.api.sendMessage(parseInt(event.chatId), "_Stopped_", { parse_mode: "Markdown" });
			}
		} catch (err) {
			log.logWarning(`[${event.chatId}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
		}
	}

	private createTelegramContext(
		event: TelegramEvent,
		session: SessionMeta,
		isScheduledEvent?: boolean,
	): TelegramContext {
		let messageId: number | null = null;
		let accumulatedText = "";
		let isWorking = true;
		const workingIndicator = " \u2026"; // ellipsis
		let updatePromise = Promise.resolve();
		const chatIdNum = parseInt(event.chatId);

		return {
			message: {
				text: event.text,
				user: event.user,
				userName: event.userName,
				chatId: event.chatId,
				ts: event.ts,
				attachments: event.attachments || [],
			},

			respond: async (text: string, shouldLog = true) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;

					if (messageId) {
						try {
							await this.bot.api.editMessageText(chatIdNum, messageId, displayText);
						} catch {
							const result = await this.bot.api.sendMessage(chatIdNum, displayText);
							messageId = result.message_id;
						}
					} else {
						const result = await this.bot.api.sendMessage(chatIdNum, displayText);
						messageId = result.message_id;
					}

					if (shouldLog && messageId) {
						this.logBotResponse(event.chatId, session.id, text, messageId.toString());
					}
				});
				await updatePromise;
			},

			replaceMessage: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					accumulatedText = text;
					const displayText = isWorking ? accumulatedText + workingIndicator : accumulatedText;
					if (messageId) {
						try {
							await this.bot.api.editMessageText(chatIdNum, messageId, displayText);
						} catch {
							const result = await this.bot.api.sendMessage(chatIdNum, displayText);
							messageId = result.message_id;
						}
					} else {
						const result = await this.bot.api.sendMessage(chatIdNum, displayText);
						messageId = result.message_id;
					}
				});
				await updatePromise;
			},

			respondInThread: async (text: string) => {
				updatePromise = updatePromise.then(async () => {
					if (messageId) {
						await this.bot.api.sendMessage(chatIdNum, text, { reply_to_message_id: messageId });
					} else {
						await this.bot.api.sendMessage(chatIdNum, text);
					}
				});
				await updatePromise;
			},

			setTyping: async (_isTyping: boolean) => {
				updatePromise = updatePromise.then(async () => {
					if (!messageId) {
						const statusText = isScheduledEvent ? `_\u2192 Event\u2026_` : `_Thinking\u2026_`;
						const result = await this.bot.api.sendMessage(chatIdNum, statusText, { parse_mode: "Markdown" });
						messageId = result.message_id;
						accumulatedText = statusText.replace(workingIndicator, "");
					}
				});
				await updatePromise;
			},

			uploadFile: async (filePath: string, title?: string) => {
				await this.bot.api.sendDocument(chatIdNum, new InputFile(filePath), { caption: title });
			},

			setWorking: async (working: boolean) => {
				updatePromise = updatePromise.then(async () => {
					isWorking = working;
					if (messageId) {
						const displayText = working ? accumulatedText + workingIndicator : accumulatedText;
						try {
							await this.bot.api.editMessageText(chatIdNum, messageId, displayText);
						} catch {
							// Ignore – text may be unchanged
						}
					}
				});
				await updatePromise;
			},

			deleteMessage: async () => {
				updatePromise = updatePromise.then(async () => {
					if (messageId) {
						try {
							await this.bot.api.deleteMessage(chatIdNum, messageId);
							messageId = null;
						} catch {
							/* Ignore */
						}
					}
				});
				await updatePromise;
			},
		};
	}

	// ==========================================================================
	// Private - Command Dispatch
	// ==========================================================================

	private setupHandlers() {
		this.bot.catch((err) => {
			const ctx = err.ctx;
			log.error(`Error in update ${ctx.update.update_id}:`, String(err.error));
			ctx.reply(`Error: ${err.error instanceof Error ? err.error.message : String(err.error)}`).catch(() => { });
		});

		// /start
		this.bot.command("start", (ctx) =>
			ctx.reply(
				"I'm your autonomous assistant.\n\n" +
				"Session commands:\n" +
				"`/sessions` — list all sessions\n" +
				"`/new` — start a new session\n" +
				"`/resume <id>` — resume a session\n" +
				"`/delete <id>` — delete a session\n\n" +
				"Other commands:\n" +
				"`/model` — view or change AI model\n" +
				"`/stop` — stop current task",
				{ parse_mode: "Markdown" },
			),
		);

		// Handle callback queries
		this.bot.on("callback_query:data", async (ctx) => {
			const data = ctx.callbackQuery.data;
			const chatId = ctx.chat?.id.toString();
			if (!chatId) return;

			// Model Selection
			if (data.startsWith("set_model:")) {
				const modelFullId = data.slice("set_model:".length);
				this.modelRegistry.refresh();
				const parts = modelFullId.split("/");
				const found =
					parts.length === 2
						? this.modelRegistry.find(parts[0], parts[1])
						: this.modelRegistry.getAvailable().find((m) => m.id === modelFullId);

				if (!found) {
					await ctx.answerCallbackQuery({ text: "Model not found", show_alert: true });
					return;
				}
				this.channelModels.set(chatId, `${found.provider}/${found.id}`);
				await ctx.editMessageText(`✅ Model changed to \`${found.provider}/${found.id}\``, {
					parse_mode: "Markdown",
				});
				await ctx.answerCallbackQuery({ text: `Model set to ${found.id}` });
				return;
			}

			// Session Resume
			if (data.startsWith("sess_resume:")) {
				const sessionId = data.slice("sess_resume:".length);
				const { state } = this.getChannelState(chatId);
				if (state.running) {
					await ctx.answerCallbackQuery({ text: "Cannot switch while busy", show_alert: true });
					return;
				}

				const meta = this.sessionManager.resumeSession(chatId, sessionId);
				if (!meta) {
					await ctx.answerCallbackQuery({ text: "Session not found", show_alert: true });
					return;
				}

				this.channelStates.delete(chatId);
				await ctx.editMessageText(`✅ Resumed session: *${escapeMarkdown(meta.title)}* (\`${meta.id}\`)`, {
					parse_mode: "Markdown",
				});
				await ctx.answerCallbackQuery({ text: `Resumed ${meta.id}` });
				return;
			}

			// Session Delete Toggle
			if (data.startsWith("sess_del_toggle:")) {
				const sessionId = data.slice("sess_del_toggle:".length);
				let selections = this.deleteSelections.get(chatId);
				if (!selections) {
					selections = new Set();
					this.deleteSelections.set(chatId, selections);
				}

				if (selections.has(sessionId)) {
					selections.delete(sessionId);
				} else {
					selections.add(sessionId);
				}

				// Refresh delete menu
				const keyboard = this.createDeleteKeyboard(chatId);
				await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
				await ctx.answerCallbackQuery();
				return;
			}

			// Session Delete Confirm
			if (data === "sess_del_confirm") {
				const selections = this.deleteSelections.get(chatId);
				if (!selections || selections.size === 0) {
					await ctx.answerCallbackQuery({ text: "No sessions selected", show_alert: true });
					return;
				}

				const { state } = this.getChannelState(chatId);
				const deletedIds: string[] = [];
				for (const id of selections) {
					if (state.running && state.sessionId === id) continue; // Skip active busy session
					this.sessionManager.deleteSession(chatId, id);
					dropRunner(chatId, id);
					if (state.sessionId === id) this.channelStates.delete(chatId);
					deletedIds.push(id);
				}

				this.deleteSelections.delete(chatId);
				await ctx.editMessageText(`🗑 Deleted ${deletedIds.length} session(s): \`${deletedIds.join(", ")}\``, {
					parse_mode: "Markdown",
				});
				await ctx.answerCallbackQuery({ text: `Deleted ${deletedIds.length} sessions` });
				return;
			}

			// Session Delete Cancel
			if (data === "sess_del_cancel") {
				this.deleteSelections.delete(chatId);
				await ctx.editMessageText("Delete cancelled.");
				await ctx.answerCallbackQuery();
				return;
			}
		});

		// /sessions — list all sessions
		this.bot.command("sessions", async (ctx) => {
			const chatId = ctx.chat.id.toString();
			const sessions = this.sessionManager.listSessions(chatId);
			const activeId = this.sessionManager.getActiveSessionId(chatId);

			if (sessions.length === 0) {
				await ctx.reply("No sessions yet. Send a message to start one.");
				return;
			}

			const keyboard = new InlineKeyboard();
			for (const s of sessions) {
				const isActive = s.id === activeId;
				const label = `${isActive ? "▶ " : ""}${s.title} (${s.id})`;
				keyboard.text(label, `sess_resume:${s.id}`).row();
			}

			await ctx.reply("*Sessions (Select to resume)*", { parse_mode: "Markdown", reply_markup: keyboard });
		});

		// /new — start a fresh session
		this.bot.command("new", async (ctx) => {
			const chatId = ctx.chat.id.toString();

			const { state } = this.getChannelState(chatId);
			if (state.running) {
				await ctx.reply("_Cannot create a new session while busy. Send `stop` first._", { parse_mode: "Markdown" });
				return;
			}

			// Create new session and reset state
			const session = this.sessionManager.createSession(chatId, "New session");
			this.channelStates.delete(chatId); // force recreation with new session

			await ctx.reply(`*New session started*\nID: \`${session.id}\`\n\nSend your first message to begin\\.`, {
				parse_mode: "MarkdownV2",
			});
		});

		// /resume <id> — switch to a previous session
		this.bot.command("resume", async (ctx) => {
			const chatId = ctx.chat.id.toString();
			const sessionId = ctx.match?.trim();

			if (!sessionId) {
				const sessions = this.sessionManager.listSessions(chatId);
				const activeId = this.sessionManager.getActiveSessionId(chatId);
				await ctx.reply(formatSessionsList(sessions, activeId), { parse_mode: "MarkdownV2" });
				return;
			}

			const { state } = this.getChannelState(chatId);
			if (state.running) {
				await ctx.reply("_Cannot switch sessions while busy. Send `stop` first._", { parse_mode: "Markdown" });
				return;
			}

			const meta = this.sessionManager.resumeSession(chatId, sessionId);
			if (!meta) {
				await ctx.reply(`Session \`${sessionId}\` not found\\.`, { parse_mode: "MarkdownV2" });
				return;
			}

			// Force state recreation with new session
			this.channelStates.delete(chatId);

			await ctx.reply(
				`*Resumed session*\n\`${meta.id}\` — ${escapeMarkdown(meta.title)}\n${meta.messageCount} messages`,
				{ parse_mode: "MarkdownV2" },
			);
		});

		// /delete <id> — delete a session
		this.bot.command("delete", async (ctx) => {
			const chatId = ctx.chat.id.toString();
			const sessionId = ctx.match?.trim();

			if (sessionId) {
				// Direct command mode
				const { state } = this.getChannelState(chatId);
				if (state.running && state.sessionId === sessionId) {
					await ctx.reply("_Cannot delete the currently running session. Send `stop` first._", {
						parse_mode: "Markdown",
					});
					return;
				}

				const meta = this.sessionManager.getSession(chatId, sessionId);
				if (!meta) {
					await ctx.reply(`Session \`${sessionId}\` not found.`, { parse_mode: "Markdown" });
					return;
				}

				this.sessionManager.deleteSession(chatId, sessionId);
				dropRunner(chatId, sessionId);
				if (state.sessionId === sessionId) this.channelStates.delete(chatId);

				await ctx.reply(`🗑 Deleted session: *${meta.title}* (\`${sessionId}\`)`, { parse_mode: "Markdown" });
				return;
			}

			// Keyboard mode
			const sessions = this.sessionManager.listSessions(chatId);
			if (sessions.length === 0) {
				await ctx.reply("No sessions to delete.");
				return;
			}

			this.deleteSelections.delete(chatId);
			const keyboard = this.createDeleteKeyboard(chatId);
			await ctx.reply("*Select sessions to delete:*", { parse_mode: "Markdown", reply_markup: keyboard });
		});

		// /model
		this.bot.command("model", async (ctx) => {
			this.modelRegistry.refresh();
			const chatId = ctx.chat.id.toString();
			const current = this.channelModels.get(chatId);
			const available = this.modelRegistry.getAvailable();

			if (available.length === 0) {
				await ctx.reply("No models available. Add API keys to `.pi/auth.json`.", { parse_mode: "Markdown" });
				return;
			}

			const keyboard = new InlineKeyboard();
			for (let i = 0; i < available.length; i++) {
				const m = available[i];
				const fullId = `${m.provider}/${m.id}`;
				const label = fullId === current ? `✅ ${fullId}` : fullId;

				// Telegram callback_data limit is 64 bytes
				keyboard.text(label, `set_model:${fullId}`);
				if ((i + 1) % 1 === 0) keyboard.row();
			}

			await ctx.reply(`*Current model:* \`${current || "(auto)"}\`\n\nSelect a model below:`, {
				parse_mode: "Markdown",
				reply_markup: keyboard,
			});
		});

		// /stop
		this.bot.command("stop", async (ctx) => {
			const chatId = ctx.chat.id.toString();
			const state = this.channelStates.get(chatId);
			if (state?.running) {
				state.stopRequested = true;
				state.runner.abort();
				await ctx.reply("_Stopping..._", { parse_mode: "Markdown" });
			} else {
				await ctx.reply("_Nothing running_", { parse_mode: "Markdown" });
			}
		});

		// /status
		this.bot.command("status", async (ctx) => {
			const chatId = ctx.chat.id.toString();
			const { state, session } = this.getChannelState(chatId);
			const current = this.channelModels.get(chatId) || "(auto)";

			await ctx.reply(
				`*Status:* ${state.running ? "Working" : "Idle"}\n` +
				`*Session:* \`${session.id}\` — ${session.title}\n` +
				`*Model:* \`${current}\``,
				{ parse_mode: "Markdown" },
			);
		});

		// Text messages
		this.bot.on("message:text", async (ctx) => {
			const chatId = ctx.chat.id.toString();
			const text = ctx.message.text;
			const userName = ctx.from?.username || ctx.from?.first_name || "unknown";

			if (text.toLowerCase().trim() === "stop") {
				const state = this.channelStates.get(chatId);
				if (state?.running) {
					state.stopRequested = true;
					state.runner.abort();
					await ctx.reply("_Stopping..._", { parse_mode: "Markdown" });
				} else {
					await ctx.reply("_Nothing running_", { parse_mode: "Markdown" });
				}
				return;
			}

			const { state, session } = this.getChannelState(chatId);
			if (state.running) {
				await ctx.reply("_Already working. Send `stop` to cancel._", { parse_mode: "Markdown" });
				return;
			}

			const ts = Date.now().toString();
			this.logUserMessage(chatId, session.id, userName, text, ts);
			log.logUserMessage({ chatId, userName }, text);

			const event: TelegramEvent = {
				chatId,
				ts,
				user: ctx.from?.id?.toString() || userName,
				userName,
				text,
			};

			this.getQueue(chatId).enqueue(() => this.handleEvent(event));
		});

		// Photo messages
		this.bot.on("message:photo", async (ctx) => {
			const chatId = ctx.chat.id.toString();
			const userName = ctx.from?.username || ctx.from?.first_name || "unknown";
			const caption = ctx.message.caption || "(photo)";
			const ts = Date.now().toString();

			const photo = ctx.message.photo[ctx.message.photo.length - 1];
			const file = await ctx.api.getFile(photo.file_id);
			const filePath = file.file_path;

			const attachments: Array<{ local: string }> = [];
			if (filePath) {
				const _chatDir = join(this.workingDir, chatId);
				const attachment = await this.store.downloadAndSave(
					chatId,
					filePath,
					`photo_${ts}.jpg`,
					async (fp) => {
						const url = `https://api.telegram.org/file/bot${this.bot.token}/${fp}`;
						const resp = await fetch(url);
						return Buffer.from(await resp.arrayBuffer());
					},
					ts,
				);
				attachments.push({ local: attachment.local });
			}

			const { state, session } = this.getChannelState(chatId);
			if (state.running) {
				await ctx.reply("_Already working. Send `stop` to cancel._", { parse_mode: "Markdown" });
				return;
			}

			this.logUserMessage(chatId, session.id, userName, caption, ts);
			log.logUserMessage({ chatId, userName }, caption);

			const event: TelegramEvent = {
				chatId,
				ts,
				user: ctx.from?.id?.toString() || userName,
				userName,
				text: caption,
				attachments,
			};
			this.getQueue(chatId).enqueue(() => this.handleEvent(event));
		});

		// Document messages
		this.bot.on("message:document", async (ctx) => {
			const chatId = ctx.chat.id.toString();
			const userName = ctx.from?.username || ctx.from?.first_name || "unknown";
			const caption = ctx.message.caption || `(document: ${ctx.message.document.file_name || "file"})`;
			const ts = Date.now().toString();

			const doc = ctx.message.document;
			const file = await ctx.api.getFile(doc.file_id);
			const filePath = file.file_path;

			const attachments: Array<{ local: string }> = [];
			if (filePath) {
				const attachment = await this.store.downloadAndSave(
					chatId,
					filePath,
					doc.file_name || `document_${ts}`,
					async (fp) => {
						const url = `https://api.telegram.org/file/bot${this.bot.token}/${fp}`;
						const resp = await fetch(url);
						return Buffer.from(await resp.arrayBuffer());
					},
					ts,
				);
				attachments.push({ local: attachment.local });
			}

			const { state, session } = this.getChannelState(chatId);
			if (state.running) {
				await ctx.reply("_Already working. Send `stop` to cancel._", { parse_mode: "Markdown" });
				return;
			}

			this.logUserMessage(chatId, session.id, userName, caption, ts);
			log.logUserMessage({ chatId, userName }, caption);

			const event: TelegramEvent = {
				chatId,
				ts,
				user: ctx.from?.id?.toString() || userName,
				userName,
				text: caption,
				attachments,
			};
			this.getQueue(chatId).enqueue(() => this.handleEvent(event));
		});
	}

	private createDeleteKeyboard(chatId: string): InlineKeyboard {
		const sessions = this.sessionManager.listSessions(chatId);
		const selections = this.deleteSelections.get(chatId) || new Set();
		const keyboard = new InlineKeyboard();

		for (const s of sessions) {
			const isSelected = selections.has(s.id);
			const label = `${isSelected ? "✅" : "⬜️"} ${s.title} (${s.id})`;
			keyboard.text(label, `sess_del_toggle:${s.id}`).row();
		}

		if (selections.size > 0) {
			keyboard.text(`🗑 Confirm Delete (${selections.size})`, "sess_del_confirm");
		}
		keyboard.text("❌ Cancel", "sess_del_cancel");

		return keyboard;
	}

	// ==========================================================================
	// Public API
	// ==========================================================================

	async start(): Promise<void> {
		log.logStartup(
			this.workingDir,
			this.sandboxConfig.type === "host" ? "host" : `docker:${(this.sandboxConfig as any).container}`,
			this.piDir,
		);

		this.eventsWatcher.start();

		this.bot.start({
			onStart: () => log.logConnected(),
		});
	}

	stop(): void {
		this.eventsWatcher.stop();
		this.bot.stop();
	}
}
