#!/usr/bin/env node

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const SEARXNG_URL = "http://searxng-a8cgcsg8wcwg8csc04c8ks0w.65.109.1.92.sslip.io/search";

const args = process.argv.slice(2);

const contentIndex = args.indexOf("--content");
const fetchContent = contentIndex !== -1;
if (fetchContent) args.splice(contentIndex, 1);

let numResults = 5;
const nIndex = args.indexOf("-n");
if (nIndex !== -1 && args[nIndex + 1]) {
	numResults = parseInt(args[nIndex + 1], 10);
	args.splice(nIndex, 2);
}

// Parse language/locale option
let language = "en-US";
const langIndex = args.indexOf("--lang");
if (langIndex !== -1 && args[langIndex + 1]) {
	language = args[langIndex + 1];
	args.splice(langIndex, 2);
}

const query = args.join(" ");

if (!query) {
	console.log("Usage: search.js <query> [-n <num>] [--content] [--lang <language>]");
	console.log("\nOptions:");
	console.log("  -n <num>              Number of results (default: 5)");
	console.log("  --content             Fetch readable content as markdown");
	console.log("  --lang <language>     Language/locale (default: en-US)");
	console.log("\nExamples:");
	console.log('  search.js "javascript async await"');
	console.log('  search.js "!wp paris"');
	console.log('  search.js "news" --content');
	process.exit(1);
}

async function fetchSearXNGResults(query, numResults, language) {
	const params = new URLSearchParams({
		q: query,
		format: "json",
		language: language,
	});

	const url = `${SEARXNG_URL}?${params.toString()}`;

	const response = await fetch(url);

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`HTTP ${response.status}: ${response.statusText}\n${errorText}`);
	}

	const data = await response.json();

	if (!data.results || !Array.isArray(data.results)) {
		return [];
	}

	return data.results.slice(0, numResults).map(result => ({
		title: result.title || "",
		link: result.url || "",
		snippet: result.content || "",
		age: result.publishedDate || result.pubdate || "",
		engine: result.engine || "",
	}));
}

function htmlToMarkdown(html) {
	const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
	turndown.use(gfm);
	turndown.addRule("removeEmptyLinks", {
		filter: (node) => node.nodeName === "A" && !node.textContent?.trim(),
		replacement: () => "",
	});
	return turndown
		.turndown(html)
		.replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
		.replace(/ +/g, " ")
		.replace(/\s+,/g, ",")
		.replace(/\s+\./g, ".")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

async function fetchPageContent(url) {
	try {
		const response = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
				"Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
			},
			signal: AbortSignal.timeout(10000),
		});

		if (!response.ok) {
			return `(HTTP ${response.status})`;
		}

		const html = await response.text();
		const dom = new JSDOM(html, { url });
		const reader = new Readability(dom.window.document);
		const article = reader.parse();

		if (article && article.content) {
			return htmlToMarkdown(article.content).substring(0, 5000);
		}

		const fallbackDoc = new JSDOM(html, { url });
		const body = fallbackDoc.window.document;
		body.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach(el => el.remove());
		const main = body.querySelector("main, article, [role='main'], .content, #content") || body.body;
		const text = main?.textContent || "";

		if (text.trim().length > 100) {
			return text.trim().substring(0, 5000);
		}

		return "(Could not extract content)";
	} catch (e) {
		return `(Error: ${e.message})`;
	}
}

// Main
try {
	const results = await fetchSearXNGResults(query, numResults, language);

	if (results.length === 0) {
		console.error("No results found.");
		process.exit(0);
	}

	if (fetchContent) {
		for (const result of results) {
			result.content = await fetchPageContent(result.link);
		}
	}

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		console.log(`--- Result ${i + 1} ---`);
		console.log(`Title: ${r.title}`);
		console.log(`Link: ${r.link}`);
		if (r.age) {
			console.log(`Age: ${r.age}`);
		}
		if (r.engine) {
			console.log(`Engine: ${r.engine}`);
		}
		console.log(`Snippet: ${r.snippet}`);
		if (r.content) {
			console.log(`Content:\n${r.content}`);
		}
		console.log("");
	}
} catch (e) {
	console.error(`Error: ${e.message}`);
	process.exit(1);
}
