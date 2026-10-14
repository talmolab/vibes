# Claude Instructions for vibes.tlab.sh

Build self-contained HTML vibes (tools/applets) following these patterns.

## Vibe Structure

Every vibe is a single `index.html` file in `<vibe-name>/`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Vibe Name</title>
    <style>
        * { box-sizing: border-box; }
        body {
            font-family: system-ui, -apple-system, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            line-height: 1.6;
        }
        @media (max-width: 600px) {
            body { padding: 15px; }
        }
    </style>
</head>
<body>
    <h1>Vibe Name</h1>
    <p>Brief description.</p>
    <!-- UI here -->
    <script>
        // Logic here
    </script>
</body>
</html>
```

## Core Rules

1. **Single file** - All HTML, CSS, JS in one `index.html`
2. **No build** - No React, npm, webpack, TypeScript
3. **CDN only** - External libs from jsDelivr/cdnjs
4. **Small** - Target <300 lines, max 500
5. **Mobile-first** - Responsive, touch-friendly, 16px min font

## Security

- Use `.textContent` not `.innerHTML` for user input (prevents XSS)
- Use `encodeURIComponent()` for URL parameters
- Never use `eval()` or `Function()` with user data
- Sanitize any data loaded from external sources

## CSS

```css
* { box-sizing: border-box; }
body {
    font-family: system-ui, -apple-system, sans-serif;
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
}
input, textarea, select { font-size: 16px; } /* Prevents iOS zoom */
@media (max-width: 600px) { body { padding: 15px; } }
```

## JavaScript

- Use `const`/`let`, never `var`
- Use `input` events for real-time updates
- Use `async`/`await` for async code
- Handle clipboard with fallback:

```javascript
navigator.clipboard.writeText(text)
    .then(() => showFeedback('Copied!'))
    .catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
    });
```

## URL State

```javascript
// Read
const hash = decodeURIComponent(location.hash.slice(1));

// Write
location.hash = encodeURIComponent(value);

// Listen
window.addEventListener('hashchange', update);
```

## CORS Issues

If you need to fetch from an API that blocks browser CORS requests, use the [nocors.tlab.sh](https://github.com/talmolab/nocors) proxy:

```javascript
// Prepend the proxy URL to your target URL
const proxyUrl = 'https://nocors.tlab.sh/';
const targetUrl = 'https://api.example.com/data';

const response = await fetch(proxyUrl + targetUrl);
const data = await response.json();
```

Note: The proxy only works from whitelisted origins (`*.tlab.sh`, `*.sleap.ai`, `*.slp.sh`, `*.talmolab.org`).
It returns 403 with no CORS headers to anything else, so the proxy path can't be tested
from `localhost` — detect that case and say so rather than showing a retry button that
can't work.

**Don't trust `curl` alone when checking whether a fetch will work.** `curl -H 'Origin: …'`
omits the `Sec-Fetch-*` headers every browser sends, and some hosts key off them, so a URL
can look perfectly fetchable from the shell and still fail in the page. Google Drive is the
worst case: `drive.usercontent.google.com` returns `200` with `access-control-allow-origin: *`
to plain curl, but **403** to any request carrying `Sec-Fetch-Site: cross-site` — which
browsers always send on a cross-origin fetch and JS cannot override. Always test with:

```bash
curl -sSI -H 'Origin: https://vibes.tlab.sh' -H 'Sec-Fetch-Site: cross-site' <url>
```

A useful consequence: `vibes.tlab.sh` → `nocors.tlab.sh` is *same-site*, so going through
the proxy makes the browser send `Sec-Fetch-Site: same-site`, which such hosts accept. When
a host blocks cross-site fetches, the proxy is the only option — no CORS header will help.

Also remember a `fetch()` CORS failure is indistinguishable from DNS/offline/mixed-content
in JS: it throws a `TypeError` with no status. Don't claim to know which one happened.

## Common CDN Libraries

```html
<!-- Markdown -->
<script src="https://cdn.jsdelivr.net/npm/marked@18.0.9/lib/marked.umd.js"></script>

<!-- Sanitizer - REQUIRED with marked if the markdown isn't yours (see below) -->
<script src="https://cdn.jsdelivr.net/npm/dompurify@3.4.13/dist/purify.min.js"></script>

<!-- Syntax highlighting -->
<script src="https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js"></script>

<!-- Charts -->
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1/dist/chart.umd.min.js"></script>

<!-- Date handling -->
<script src="https://cdn.jsdelivr.net/npm/dayjs@1.11.21/dayjs.min.js"></script>
```

**Pin exact versions.** Unpinned and major-only jsDelivr URLs are mutable
(`s-maxage=43200`), so you can't use `integrity`/SRI and the version drifts under you.
An exact version is served `immutable`.

**`marked` moved its bundle.** The package-root `marked.min.js` exists up to 15.x and
**404s from 16.0.0 onward**, so `marked@16`/`@17`/`@18` + `marked.min.js` is a dead URL.
Worse, *unpinned* `npm/marked/marked.min.js` returns 200 but silently serves **15.0.12**
(the newest version that still ships that path) — so it looks fine while pinning you to
an old major. Use `marked@<version>/lib/marked.umd.js`, which is already minified.

**`window.marked` is an object, not a function** — `marked(md)` throws, use
`marked.parse(md)`. GFM (tables, task lists, strikethrough, autolinks) is on by default.
Options removed in v5+ (`headerIds`, `mangle`, `sanitize`, `highlight`) are *silently
ignored* — no warning, no throw — so heading `id`s are not emitted; generate them
yourself if you need in-page anchors.

**Rendering markdown you didn't write is an XSS hole.** `marked.parse()` passes raw HTML
(`<script>`, `<img onerror>`, `javascript:` links) straight through, and rendering it
means `innerHTML`, so the "use `.textContent`" rule above can't save you. Sanitize first:

```javascript
el.replaceChildren(DOMPurify.sanitize(marked.parse(md), {
    ALLOWED_TAGS: ['a','b','blockquote','br','code','em','h1','h2','h3','h4','hr','i',
        'img','input','li','ol','p','pre','s','span','strong','table','tbody','td',
        'th','thead','tr','ul'],
    ALLOWED_ATTR: ['href','src','alt','title','align','colspan','rowspan','type','checked'],
    FORBID_TAGS: ['style','svg','form','iframe','object','embed','base','meta'],
    FORBID_ATTR: ['style','srcset','target','name','onerror','onload'],
    RETURN_DOM_FRAGMENT: true,
}));
```

Forbid `style` as both **tag and attribute**: `<svg><style>` leaks CSS into page scope in
DOMPurify 3.4.13's default config, and a live `style=` attribute allows a full-page
`position:fixed` clickjack overlay. Don't use `USE_PROFILES: {html:true}` — it overwrites
your `ALLOWED_TAGS`/`ALLOWED_ATTR`. See `md/` for a worked example.

## Local Development

### Web Server
Use `npx serve` for local testing (run in background to avoid blocking):
```bash
npx serve -p 8080 --cors --no-clipboard &
# Then open http://localhost:8080/my-vibe/
```

### Python
Always use `uv` for running Python:
```bash
uv run script.py
```

## Testing with Playwright MCP

Use Playwright MCP to visually test vibes in a real browser.

### Setup (one-time)
```bash
claude mcp add playwright -- npx @playwright/mcp@latest
```

### Usage
Start a local server, then use Playwright to test:
```
1. Run: npx serve -p 8080 --cors --no-clipboard &
2. Ask Claude: "Use playwright mcp to open http://localhost:8080/my-vibe/ and test it"
```

Claude can then:
- Navigate and interact with the vibe
- Test mobile viewport (resize to 375px width)
- Verify copy button works
- Check for console errors
- Take screenshots for review

## After Creating a Vibe

1. Add to `README.md`:
   ```markdown
   - [Vibe Name](vibe-name/) - brief description
   ```

2. Test locally (with Playwright MCP):
   - Works on mobile (375px viewport)
   - Copy button works
   - No console errors
   - URL state works (if applicable)

3. Create PR:
   - Branch from `main`
   - Open PR with description
   - **Include deployment link**: `https://vibes.tlab.sh/<vibe-name>/`
   - Squash merge when approved

## Investigations and Scratch Work

The `scratch/` directory is gitignored for local experimentation. When distilling findings into PRs:
- Do NOT assume scratch notes will be checked in
- Include all relevant information inline in PR descriptions or committed files
- Copy key findings, code snippets, or data directly into the PR
