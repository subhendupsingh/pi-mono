import { existsSync, mkdirSync, readFileSync } from "fs";
import { appendFile, writeFile } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";

export interface Attachment {
	original: string;
	local: string; // path relative to working dir
}

export interface LoggedMessage {
	date: string;
	ts: string;
	user: string;
	userName?: string;
	displayName?: string;
	text: string;
	attachments: Attachment[];
	isBot: boolean;
}

export interface ChannelStoreConfig {
	workingDir: string;
}

export class ChannelStore {
	private workingDir: string;
	// Track recently logged message timestamps to prevent duplicates
	private recentlyLogged = new Map<string, number>();

	constructor(config: ChannelStoreConfig) {
		this.workingDir = config.workingDir;

		if (!existsSync(this.workingDir)) {
			mkdirSync(this.workingDir, { recursive: true });
		}
	}

	getChannelDir(chatId: string): string {
		const dir = join(this.workingDir, chatId);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		return dir;
	}

	generateLocalFilename(originalName: string, timestamp: string): string {
		const ts = Math.floor(parseFloat(timestamp) * 1000) || Date.now();
		const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
		return `${ts}_${sanitized}`;
	}

	/**
	 * Log a message to the channel's log.jsonl
	 */
	async logMessage(chatId: string, message: LoggedMessage): Promise<boolean> {
		const dedupeKey = `${chatId}:${message.ts}`;
		if (this.recentlyLogged.has(dedupeKey)) {
			return false;
		}

		this.recentlyLogged.set(dedupeKey, Date.now());
		setTimeout(() => this.recentlyLogged.delete(dedupeKey), 60000);

		const logPath = join(this.getChannelDir(chatId), "log.jsonl");

		if (!message.date) {
			message.date = new Date(parseInt(message.ts, 10)).toISOString();
		}

		const line = `${JSON.stringify(message)}\n`;
		await appendFile(logPath, line, "utf-8");
		return true;
	}

	/**
	 * Log a bot response
	 */
	async logBotResponse(chatId: string, text: string, ts: string): Promise<void> {
		await this.logMessage(chatId, {
			date: new Date().toISOString(),
			ts,
			user: "bot",
			text,
			attachments: [],
			isBot: true,
		});
	}

	/**
	 * Log a user message
	 */
	logUserMessage(chatId: string, userName: string, text: string, ts: string): void {
		this.logMessage(chatId, {
			date: new Date(parseInt(ts, 10)).toISOString(),
			ts,
			user: userName,
			userName,
			text,
			attachments: [],
			isBot: false,
		});
	}

	/**
	 * Download a Telegram file and save it locally
	 */
	async downloadAndSave(
		chatId: string,
		filePath: string,
		originalName: string,
		downloadFn: (filePath: string) => Promise<Buffer>,
		timestamp: string,
	): Promise<Attachment> {
		const filename = this.generateLocalFilename(originalName, timestamp);
		const localPath = `${chatId}/attachments/${filename}`;
		const fullPath = join(this.workingDir, localPath);

		const dir = join(this.workingDir, chatId, "attachments");
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		try {
			const buffer = await downloadFn(filePath);
			await writeFile(fullPath, buffer);
		} catch (error) {
			log.logWarning(`Failed to download attachment`, `${localPath}: ${error}`);
		}

		return {
			original: originalName,
			local: localPath,
		};
	}
}
