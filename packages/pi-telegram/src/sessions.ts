/**
 * Session management for pi-telegram.
 *
 * Each Telegram chat can have multiple sessions, each with its own
 * context.jsonl (LLM history) and log.jsonl (human-readable).
 *
 * Layout:
 *   data/<chatId>/
 *     sessions.json          # index of all sessions
 *     active_session         # current active session id (plain text)
 *     sessions/
 *       <sessionId>/
 *         context.jsonl      # LLM conversation history
 *         log.jsonl          # human-readable log
 */

import { randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import * as log from "./log.js";

// ============================================================================
// Types
// ============================================================================

export interface SessionMeta {
	id: string;
	title: string;
	createdAt: string; // ISO 8601
	lastMessageAt: string; // ISO 8601
	messageCount: number;
}

export interface SessionsIndex {
	sessions: SessionMeta[];
}

// ============================================================================
// Paths
// ============================================================================

function chatDir(workingDir: string, chatId: string): string {
	return join(workingDir, chatId);
}

function sessionsIndexPath(workingDir: string, chatId: string): string {
	return join(chatDir(workingDir, chatId), "sessions.json");
}

function activeSessionPath(workingDir: string, chatId: string): string {
	return join(chatDir(workingDir, chatId), "active_session");
}

function sessionDir(workingDir: string, chatId: string, sessionId: string): string {
	return join(chatDir(workingDir, chatId), "sessions", sessionId);
}

export function sessionContextPath(workingDir: string, chatId: string, sessionId: string): string {
	return join(sessionDir(workingDir, chatId, sessionId), "context.jsonl");
}

export function sessionLogPath(workingDir: string, chatId: string, sessionId: string): string {
	return join(sessionDir(workingDir, chatId, sessionId), "log.jsonl");
}

// ============================================================================
// Index CRUD
// ============================================================================

function readIndex(workingDir: string, chatId: string): SessionsIndex {
	const path = sessionsIndexPath(workingDir, chatId);
	if (!existsSync(path)) {
		return { sessions: [] };
	}
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as SessionsIndex;
	} catch {
		return { sessions: [] };
	}
}

function writeIndex(workingDir: string, chatId: string, index: SessionsIndex): void {
	const dir = chatDir(workingDir, chatId);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(sessionsIndexPath(workingDir, chatId), JSON.stringify(index, null, 2));
}

// ============================================================================
// Session Manager
// ============================================================================

export class SessionManager {
	constructor(private workingDir: string) { }

	// --------------------------------------------------------------------------
	// Active session
	// --------------------------------------------------------------------------

	getActiveSessionId(chatId: string): string | null {
		const path = activeSessionPath(this.workingDir, chatId);
		if (!existsSync(path)) return null;
		const id = readFileSync(path, "utf-8").trim();
		return id || null;
	}

	setActiveSession(chatId: string, sessionId: string): void {
		const dir = chatDir(this.workingDir, chatId);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(activeSessionPath(this.workingDir, chatId), sessionId, "utf-8");
	}

	clearActiveSession(chatId: string): void {
		const path = activeSessionPath(this.workingDir, chatId);
		if (existsSync(path)) unlinkSync(path);
	}

	// --------------------------------------------------------------------------
	// Create
	// --------------------------------------------------------------------------

	createSession(chatId: string, title = "New session"): SessionMeta {
		const id = randomBytes(4).toString("hex"); // e.g. "a3f8c1d2"
		const now = new Date().toISOString();

		const meta: SessionMeta = {
			id,
			title,
			createdAt: now,
			lastMessageAt: now,
			messageCount: 0,
		};

		// Create session directory
		const dir = sessionDir(this.workingDir, chatId, id);
		mkdirSync(dir, { recursive: true });

		// Add to index
		const index = readIndex(this.workingDir, chatId);
		index.sessions.unshift(meta); // newest first
		writeIndex(this.workingDir, chatId, index);

		// Set as active
		this.setActiveSession(chatId, id);

		log.logInfo(`[${chatId}] Created session ${id}: "${title}"`);
		return meta;
	}

	// --------------------------------------------------------------------------
	// Read
	// --------------------------------------------------------------------------

	getSession(chatId: string, sessionId: string): SessionMeta | null {
		const index = readIndex(this.workingDir, chatId);
		return index.sessions.find((s) => s.id === sessionId) ?? null;
	}

	listSessions(chatId: string): SessionMeta[] {
		const index = readIndex(this.workingDir, chatId);
		return index.sessions;
	}

	/**
	 * Get or create the active session.
	 * If none exists, creates a new "New session" placeholder.
	 */
	getOrCreateActiveSession(chatId: string): SessionMeta {
		const activeId = this.getActiveSessionId(chatId);
		if (activeId) {
			const meta = this.getSession(chatId, activeId);
			if (meta) return meta;
		}
		// No active session — create one
		return this.createSession(chatId, "New session");
	}

	// --------------------------------------------------------------------------
	// Update
	// --------------------------------------------------------------------------

	updateSessionTitle(chatId: string, sessionId: string, title: string): void {
		const index = readIndex(this.workingDir, chatId);
		const session = index.sessions.find((s) => s.id === sessionId);
		if (!session) return;
		session.title = title;
		writeIndex(this.workingDir, chatId, index);
	}

	touchSession(chatId: string, sessionId: string): void {
		const index = readIndex(this.workingDir, chatId);
		const session = index.sessions.find((s) => s.id === sessionId);
		if (!session) return;
		session.lastMessageAt = new Date().toISOString();
		session.messageCount++;
		writeIndex(this.workingDir, chatId, index);
	}

	// --------------------------------------------------------------------------
	// Resume
	// --------------------------------------------------------------------------

	resumeSession(chatId: string, sessionId: string): SessionMeta | null {
		const meta = this.getSession(chatId, sessionId);
		if (!meta) return null;
		this.setActiveSession(chatId, sessionId);
		log.logInfo(`[${chatId}] Resumed session ${sessionId}: "${meta.title}"`);
		return meta;
	}

	// --------------------------------------------------------------------------
	// Delete
	// --------------------------------------------------------------------------

	deleteSession(chatId: string, sessionId: string): boolean {
		const index = readIndex(this.workingDir, chatId);
		const idx = index.sessions.findIndex((s) => s.id === sessionId);
		if (idx === -1) return false;

		// Remove from index
		index.sessions.splice(idx, 1);
		writeIndex(this.workingDir, chatId, index);

		// Delete files
		const dir = sessionDir(this.workingDir, chatId, sessionId);
		if (existsSync(dir)) {
			rmSync(dir, { recursive: true, force: true });
		}

		// If active session was deleted, clear it
		const activeId = this.getActiveSessionId(chatId);
		if (activeId === sessionId) {
			this.clearActiveSession(chatId);
		}

		log.logInfo(`[${chatId}] Deleted session ${sessionId}`);
		return true;
	}

	// --------------------------------------------------------------------------
	// Paths
	// --------------------------------------------------------------------------

	getContextPath(chatId: string, sessionId: string): string {
		return sessionContextPath(this.workingDir, chatId, sessionId);
	}

	getLogPath(chatId: string, sessionId: string): string {
		return sessionLogPath(this.workingDir, chatId, sessionId);
	}

	getSessionDir(chatId: string, sessionId: string): string {
		return sessionDir(this.workingDir, chatId, sessionId);
	}
}

// ============================================================================
// Title Generation
// ============================================================================

/**
 * Generate a short title from the first user message.
 * Uses simple heuristics (no LLM call needed — fast and free).
 */
export function generateTitle(text: string): string {
	// Strip event prefix
	const cleaned = text
		.replace(/^\[EVENT:[^\]]+\]\s*/, "")
		.replace(/^\[[^\]]+\]\s*\[[^\]]+\]:\s*/, "") // strip timestamp + username prefix
		.trim();

	// Take first line, limit to 60 chars
	const firstLine = cleaned.split("\n")[0].trim();
	if (firstLine.length <= 60) return firstLine || "New session";

	// Try to cut at a word boundary
	const truncated = firstLine.substring(0, 57);
	const lastSpace = truncated.lastIndexOf(" ");
	return (lastSpace > 20 ? truncated.substring(0, lastSpace) : truncated) + "...";
}

// ============================================================================
// Formatting helpers for Telegram messages
// ============================================================================

function formatRelativeTime(dateStr: string): string {
	const date = new Date(dateStr);
	const now = Date.now();
	const diffMs = now - date.getTime();
	const diffMins = Math.floor(diffMs / 60000);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	if (diffMins < 1) return "just now";
	if (diffMins < 60) return `${diffMins}m ago`;
	if (diffHours < 24) return `${diffHours}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatSessionsList(sessions: SessionMeta[], activeId: string | null): string {
	if (sessions.length === 0) {
		return "No sessions yet\\. Send a message to start one\\.";
	}

	const lines: string[] = ["*Sessions*", ""];
	for (const s of sessions) {
		const isActive = s.id === activeId;
		const indicator = isActive ? "▶ " : "   ";
		const title = escapeMarkdown(truncateTitle(s.title));
		const time = escapeMarkdown(formatRelativeTime(s.lastMessageAt));
		const msgs = s.messageCount;
		lines.push(`${indicator}\`${s.id}\` *${title}*\n       ${time} · ${msgs} msg${msgs === 1 ? "" : "s"}`);
	}

	lines.push("");
	lines.push("Commands:");
	lines.push("`/new` — start new session");
	lines.push("`/resume <id>` — switch to session");
	lines.push("`/delete <id>` — delete session");

	return lines.join("\n");
}

function truncateTitle(title: string): string {
	return title.length > 35 ? title.substring(0, 32) + "..." : title;
}

export function escapeMarkdown(text: string): string {
	// Escape MarkdownV2 special chars (except already escaped)
	return text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
