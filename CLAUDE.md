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

## Common CDN Libraries

```html
<!-- Markdown -->
<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>

<!-- Syntax highlighting -->
<script src="https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build/highlight.min.js"></script>

<!-- Charts -->
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>

<!-- Date handling -->
<script src="https://cdn.jsdelivr.net/npm/dayjs@1/dayjs.min.js"></script>
```

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
