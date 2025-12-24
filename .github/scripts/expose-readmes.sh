#!/bin/bash
# Expose README.md files for each vibe in the built site
# Creates:
#   _site/{vibe}/README.md - raw markdown
#   _site/{vibe}/README/index.html - rendered with GitHub styling

set -e

SITE_DIR="${1:-_site}"
REPO_URL="https://github.com/talmolab/vibes"

# HTML template for rendering README with GitHub-flavored markdown
read -r -d '' TEMPLATE << 'EOF' || true
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{{VIBE}} - README</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/github-markdown-css/5.5.1/github-markdown.min.css">
    <style>
        :root {
            --bg-color: #ffffff;
            --header-border: #d0d7de;
            --link-color: #0969da;
            --muted-color: #57606a;
        }
        [data-theme="dark"] {
            --bg-color: #0d1117;
            --header-border: #30363d;
            --link-color: #58a6ff;
            --muted-color: #8b949e;
        }
        @media (prefers-color-scheme: dark) {
            :root:not([data-theme="light"]) {
                --bg-color: #0d1117;
                --header-border: #30363d;
                --link-color: #58a6ff;
                --muted-color: #8b949e;
            }
        }
        body {
            background: var(--bg-color);
            margin: 0;
            padding: 0;
            transition: background-color 0.2s;
        }
        .container {
            max-width: 980px;
            margin: 0 auto;
            padding: 45px;
        }
        @media (max-width: 767px) {
            .container { padding: 15px; }
        }
        .markdown-body {
            box-sizing: border-box;
            min-width: 200px;
            max-width: 980px;
        }
        @media (prefers-color-scheme: dark) {
            :root:not([data-theme="light"]) .markdown-body {
                color-scheme: dark;
                --color-prettylights-syntax-comment: #8b949e;
                --color-prettylights-syntax-constant: #79c0ff;
                --color-prettylights-syntax-entity: #d2a8ff;
                --color-prettylights-syntax-storage-modifier-import: #c9d1d9;
                --color-prettylights-syntax-entity-tag: #7ee787;
                --color-prettylights-syntax-keyword: #ff7b72;
                --color-prettylights-syntax-string: #a5d6ff;
                --color-prettylights-syntax-variable: #ffa657;
                --color-prettylights-syntax-brackethighlighter-unmatched: #f85149;
                --color-prettylights-syntax-invalid-illegal-text: #f0f6fc;
                --color-prettylights-syntax-invalid-illegal-bg: #8e1519;
                --color-prettylights-syntax-carriage-return-text: #f0f6fc;
                --color-prettylights-syntax-carriage-return-bg: #b62324;
                --color-prettylights-syntax-string-regexp: #7ee787;
                --color-prettylights-syntax-markup-list: #f2cc60;
                --color-prettylights-syntax-markup-heading: #1f6feb;
                --color-prettylights-syntax-markup-italic: #c9d1d9;
                --color-prettylights-syntax-markup-bold: #c9d1d9;
                --color-prettylights-syntax-markup-deleted-text: #ffdcd7;
                --color-prettylights-syntax-markup-deleted-bg: #67060c;
                --color-prettylights-syntax-markup-inserted-text: #aff5b4;
                --color-prettylights-syntax-markup-inserted-bg: #033a16;
                --color-prettylights-syntax-markup-changed-text: #ffdfb6;
                --color-prettylights-syntax-markup-changed-bg: #5a1e02;
                --color-prettylights-syntax-markup-ignored-text: #c9d1d9;
                --color-prettylights-syntax-markup-ignored-bg: #1158c7;
                --color-prettylights-syntax-meta-diff-range: #d2a8ff;
                --color-prettylights-syntax-sublimelinter-gutter-mark: #484f58;
                --color-fg-default: #c9d1d9;
                --color-fg-muted: #8b949e;
                --color-fg-subtle: #6e7681;
                --color-canvas-default: #0d1117;
                --color-canvas-subtle: #161b22;
                --color-border-default: #30363d;
                --color-border-muted: #21262d;
                --color-neutral-muted: rgba(110,118,129,0.4);
                --color-accent-fg: #58a6ff;
                --color-accent-emphasis: #1f6feb;
                --color-danger-fg: #f85149;
            }
        }
        [data-theme="dark"] .markdown-body {
            color-scheme: dark;
            --color-prettylights-syntax-comment: #8b949e;
            --color-prettylights-syntax-constant: #79c0ff;
            --color-prettylights-syntax-entity: #d2a8ff;
            --color-prettylights-syntax-storage-modifier-import: #c9d1d9;
            --color-prettylights-syntax-entity-tag: #7ee787;
            --color-prettylights-syntax-keyword: #ff7b72;
            --color-prettylights-syntax-string: #a5d6ff;
            --color-prettylights-syntax-variable: #ffa657;
            --color-prettylights-syntax-brackethighlighter-unmatched: #f85149;
            --color-prettylights-syntax-invalid-illegal-text: #f0f6fc;
            --color-prettylights-syntax-invalid-illegal-bg: #8e1519;
            --color-prettylights-syntax-carriage-return-text: #f0f6fc;
            --color-prettylights-syntax-carriage-return-bg: #b62324;
            --color-prettylights-syntax-string-regexp: #7ee787;
            --color-prettylights-syntax-markup-list: #f2cc60;
            --color-prettylights-syntax-markup-heading: #1f6feb;
            --color-prettylights-syntax-markup-italic: #c9d1d9;
            --color-prettylights-syntax-markup-bold: #c9d1d9;
            --color-prettylights-syntax-markup-deleted-text: #ffdcd7;
            --color-prettylights-syntax-markup-deleted-bg: #67060c;
            --color-prettylights-syntax-markup-inserted-text: #aff5b4;
            --color-prettylights-syntax-markup-inserted-bg: #033a16;
            --color-prettylights-syntax-markup-changed-text: #ffdfb6;
            --color-prettylights-syntax-markup-changed-bg: #5a1e02;
            --color-prettylights-syntax-markup-ignored-text: #c9d1d9;
            --color-prettylights-syntax-markup-ignored-bg: #1158c7;
            --color-prettylights-syntax-meta-diff-range: #d2a8ff;
            --color-prettylights-syntax-sublimelinter-gutter-mark: #484f58;
            --color-fg-default: #c9d1d9;
            --color-fg-muted: #8b949e;
            --color-fg-subtle: #6e7681;
            --color-canvas-default: #0d1117;
            --color-canvas-subtle: #161b22;
            --color-border-default: #30363d;
            --color-border-muted: #21262d;
            --color-neutral-muted: rgba(110,118,129,0.4);
            --color-accent-fg: #58a6ff;
            --color-accent-emphasis: #1f6feb;
            --color-danger-fg: #f85149;
        }
        /* Explicit light mode - overrides system dark preference */
        [data-theme="light"] .markdown-body {
            color-scheme: light;
            --color-prettylights-syntax-comment: #6e7781;
            --color-prettylights-syntax-constant: #0550ae;
            --color-prettylights-syntax-entity: #8250df;
            --color-prettylights-syntax-storage-modifier-import: #24292f;
            --color-prettylights-syntax-entity-tag: #116329;
            --color-prettylights-syntax-keyword: #cf222e;
            --color-prettylights-syntax-string: #0a3069;
            --color-prettylights-syntax-variable: #953800;
            --color-prettylights-syntax-brackethighlighter-unmatched: #82071e;
            --color-prettylights-syntax-invalid-illegal-text: #f6f8fa;
            --color-prettylights-syntax-invalid-illegal-bg: #82071e;
            --color-prettylights-syntax-carriage-return-text: #f6f8fa;
            --color-prettylights-syntax-carriage-return-bg: #cf222e;
            --color-prettylights-syntax-string-regexp: #116329;
            --color-prettylights-syntax-markup-list: #3b2300;
            --color-prettylights-syntax-markup-heading: #0550ae;
            --color-prettylights-syntax-markup-italic: #24292f;
            --color-prettylights-syntax-markup-bold: #24292f;
            --color-prettylights-syntax-markup-deleted-text: #82071e;
            --color-prettylights-syntax-markup-deleted-bg: #ffebe9;
            --color-prettylights-syntax-markup-inserted-text: #116329;
            --color-prettylights-syntax-markup-inserted-bg: #dafbe1;
            --color-prettylights-syntax-markup-changed-text: #953800;
            --color-prettylights-syntax-markup-changed-bg: #ffd8b5;
            --color-prettylights-syntax-markup-ignored-text: #eaeef2;
            --color-prettylights-syntax-markup-ignored-bg: #0550ae;
            --color-prettylights-syntax-meta-diff-range: #8250df;
            --color-prettylights-syntax-sublimelinter-gutter-mark: #8c959f;
            --color-fg-default: #24292f;
            --color-fg-muted: #57606a;
            --color-fg-subtle: #6e7781;
            --color-canvas-default: #ffffff;
            --color-canvas-subtle: #f6f8fa;
            --color-border-default: #d0d7de;
            --color-border-muted: hsla(210,18%,87%,1);
            --color-neutral-muted: rgba(175,184,193,0.2);
            --color-accent-fg: #0969da;
            --color-accent-emphasis: #0969da;
            --color-danger-fg: #cf222e;
        }
        .source-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0 20px;
            border-bottom: 1px solid var(--header-border);
            margin-bottom: 20px;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
            font-size: 14px;
        }
        .source-header a {
            color: var(--link-color);
            text-decoration: none;
        }
        .source-header a:hover { text-decoration: underline; }
        .vibe-link { font-weight: 600; }
        .muted { color: var(--muted-color) !important; }
        .theme-toggle {
            background: none;
            border: 1px solid var(--header-border);
            border-radius: 6px;
            padding: 4px 8px;
            cursor: pointer;
            font-size: 14px;
            color: var(--muted-color);
            margin-left: 12px;
        }
        .theme-toggle:hover {
            background: var(--header-border);
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="source-header">
            <a href="../" class="vibe-link">{{VIBE}}</a>
            <span>
                <a href="{{REPO_URL}}/tree/main/{{VIBE}}" target="_blank">View source</a>
                <span class="muted">&nbsp;|&nbsp;</span>
                <a href="../README.md" class="muted">Raw</a>
                <button class="theme-toggle" id="theme-toggle" title="Toggle theme">☀️</button>
            </span>
        </div>
        <article class="markdown-body" id="content">
            <p>Loading...</p>
        </article>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script>
        // Theme handling
        const toggle = document.getElementById('theme-toggle');
        const root = document.documentElement;

        function getSystemTheme() {
            return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }

        function getStoredTheme() {
            return localStorage.getItem('readme-theme');
        }

        function setTheme(theme) {
            if (theme === 'system') {
                root.removeAttribute('data-theme');
                localStorage.removeItem('readme-theme');
            } else {
                root.setAttribute('data-theme', theme);
                localStorage.setItem('readme-theme', theme);
            }
            updateToggleIcon();
        }

        function updateToggleIcon() {
            const stored = getStoredTheme();
            const effective = stored || getSystemTheme();
            toggle.textContent = effective === 'dark' ? '☀️' : '🌙';
            toggle.title = stored ? 'Using ' + stored + ' theme (click to use system)' : 'Using system theme';
        }

        toggle.addEventListener('click', () => {
            const stored = getStoredTheme();
            const system = getSystemTheme();

            if (!stored) {
                // Currently system -> switch to opposite
                setTheme(system === 'dark' ? 'light' : 'dark');
            } else if (stored === system) {
                // Stored matches system -> switch to opposite
                setTheme(system === 'dark' ? 'light' : 'dark');
            } else {
                // Stored differs from system -> go back to system
                setTheme('system');
            }
        });

        // Listen for system theme changes
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateToggleIcon);

        // Initialize
        const stored = getStoredTheme();
        if (stored) root.setAttribute('data-theme', stored);
        updateToggleIcon();

        // Markdown rendering
        marked.setOptions({ gfm: true, breaks: true });
        fetch('../README.md')
            .then(response => {
                if (!response.ok) throw new Error('README not found');
                return response.text();
            })
            .then(md => {
                document.getElementById('content').innerHTML = marked.parse(md);
            })
            .catch(err => {
                document.getElementById('content').innerHTML = '<p>Error loading README: ' + err.message + '</p>';
            });
    </script>
</body>
</html>
EOF

echo "Exposing README.md files..."
echo "Site directory: $SITE_DIR"

# Find all vibe directories (have index.html but aren't the root)
for vibe_dir in */; do
    vibe="${vibe_dir%/}"

    # Skip hidden directories and special directories
    case "$vibe" in
        .*|_*|node_modules|scratch|tmp)
            continue
            ;;
    esac

    # Skip non-vibe directories (must have index.html)
    if [ ! -f "$vibe/index.html" ]; then
        continue
    fi

    # Skip if no README.md
    if [ ! -f "$vibe/README.md" ]; then
        echo "  $vibe: no README.md, skipping"
        continue
    fi

    # Copy README.md to _site
    if [ -d "$SITE_DIR/$vibe" ]; then
        # Remove existing README.md if present (may be read-only from Jekyll running as root)
        sudo rm -f "$SITE_DIR/$vibe/README.md" 2>/dev/null || rm -f "$SITE_DIR/$vibe/README.md" 2>/dev/null || true

        # Copy with sudo (Jekyll creates files as root)
        sudo cp -f "$vibe/README.md" "$SITE_DIR/$vibe/README.md" 2>/dev/null || cp -f "$vibe/README.md" "$SITE_DIR/$vibe/README.md"
        echo "  $vibe: copied README.md"

        # Create README/index.html for rendered view
        sudo mkdir -p "$SITE_DIR/$vibe/README" 2>/dev/null || mkdir -p "$SITE_DIR/$vibe/README"
        echo "$TEMPLATE" | sed "s|{{VIBE}}|$vibe|g" | sed "s|{{REPO_URL}}|$REPO_URL|g" | sudo tee "$SITE_DIR/$vibe/README/index.html" > /dev/null 2>&1 || \
        echo "$TEMPLATE" | sed "s|{{VIBE}}|$vibe|g" | sed "s|{{REPO_URL}}|$REPO_URL|g" > "$SITE_DIR/$vibe/README/index.html"
        echo "  $vibe: created README/index.html"
    else
        echo "  $vibe: $SITE_DIR/$vibe not found, skipping"
    fi
done

echo "Done!"
