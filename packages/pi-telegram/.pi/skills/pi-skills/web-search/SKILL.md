---
name: web-search
description: Web search and content extraction via SearXNG. Use for searching documentation, facts, or any web content. Supports advanced search syntax.
---

# Web Search (SearXNG)

Web search and content extraction using a self-hosted SearXNG instance. No API key required.

## Setup

1. The skill is pre-configured to use the SearXNG instance at `http://searxng-a8cgcsg8wcwg8csc04c8ks0w.65.109.1.92.sslip.io/search`.
2. Install dependencies (run once):
   ```bash
   cd {baseDir}
   npm install
   ```

## Search

```bash
{baseDir}/search.js "query"                         # Basic search (5 results)
{baseDir}/search.js "query" -n 10                   # More results
{baseDir}/search.js "query" --content               # Include page content as markdown
{baseDir}/search.js "query" --lang de-DE            # Results in German
{baseDir}/search.js "!wp paris"                     # Search Wikipedia specifically
{baseDir}/search.js "!images cats"                  # Image search (returns links)
```

### Options

- `-n <num>` - Number of results (default: 5)
- `--content` - Fetch and include page content as markdown
- `--lang <language>` - Language/locale code (default: en-US)

### Search Syntax & Bangs

SearXNG supports powerful search syntax. Use a `!` prefix to select specific engines or categories:

#### General & Web
- `!google` or `!go` - Search Google
- `!bing` or `!bi` - Search Bing
- `!duckduckgo` or `!ddg` - Search DuckDuckGo
- `!brave` or `!br` - Search Brave
- `!wikipedia` or `!wp` - Search Wikipedia

#### IT & Development
- `!github` or `!gh` - Search GitHub repositories
- `!stackoverflow` or `!st` - Search StackOverflow
- `!npm` - Search Node Package Manager
- `!pypi` - Search Python Package Index
- `!docker` or `!dh` - Search Docker Hub
- `!arch` or `!al` - Search Arch Linux Wiki

#### Media & Files
- `!images` - Search for images across multiple engines
- `!videos` - Search for videos
- `!news` - Search news articles
- `!youtube` or `!yt` - Search YouTube

#### Science & Academic
- `!scholar` or `!gos` - Search Google Scholar
- `!arxiv` or `!arx` - Search ArXiv.org
- `!pubmed` or `!pub` - Search PubMed

#### Categories & Modifiers
- `!map` - Search for locations/maps
- `:fr` or `:de` - Filter results by language (e.g., `:fr` for French)
- `!! <query>` - "Feeling Lucky" (redirects to the first result)

Abbreviations are chainable: `!wp !go paris` searches both Wikipedia and Google for "paris".

## Extract Page Content

```bash
{baseDir}/content.js https://example.com/article
```

Fetches a URL and extracts readable content as markdown.

## Output Format

```
--- Result 1 ---
Title: Page Title
Link: https://example.com/page
Age: 2 days ago
Engine: brave
Snippet: Description from search results
Content: (if --content flag used)
  Markdown content extracted from the page...

--- Result 2 ---
...
```

## When to Use

- Searching for documentation or API references
- Looking up facts or current information
- Fetching content from specific URLs
- Using specific search engines via bangs (e.g., `!wp`, `!gh`)
