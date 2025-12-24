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
        body {
            background: #fff;
            margin: 0;
            padding: 0;
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
        .source-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 0 20px;
            border-bottom: 1px solid #d0d7de;
            margin-bottom: 20px;
        }
        .source-header a {
            color: #0969da;
            text-decoration: none;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif;
            font-size: 14px;
        }
        .source-header a:hover { text-decoration: underline; }
        .vibe-link { font-weight: 600; }
        .raw-link { color: #57606a !important; }
    </style>
</head>
<body>
    <div class="container">
        <div class="source-header">
            <a href="../" class="vibe-link">{{VIBE}}</a>
            <span>
                <a href="{{REPO_URL}}/tree/main/{{VIBE}}" target="_blank">View source</a>
                &nbsp;|&nbsp;
                <a href="README.md" class="raw-link">Raw</a>
            </span>
        </div>
        <article class="markdown-body" id="content">
            <p>Loading...</p>
        </article>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <script>
        marked.setOptions({
            gfm: true,
            breaks: true
        });
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

# Debug: show _site permissions and contents
echo "Debug: _site directory info:"
ls -la "$SITE_DIR" 2>&1 | head -20 || echo "Cannot list $SITE_DIR"

# Ensure site directory is writable (Jekyll may create with restrictive permissions)
# Use sudo if available, otherwise try regular chmod
if [ -d "$SITE_DIR" ]; then
    chmod -R u+w "$SITE_DIR" 2>/dev/null || sudo chmod -R u+w "$SITE_DIR" 2>/dev/null || true
fi

echo "Debug: after chmod:"
ls -la "$SITE_DIR" 2>&1 | head -5 || true

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
        # Remove existing README.md if present (may be read-only from Jekyll)
        rm -f "$SITE_DIR/$vibe/README.md" 2>/dev/null || true

        # Copy with force
        cp -f "$vibe/README.md" "$SITE_DIR/$vibe/README.md"
        echo "  $vibe: copied README.md"

        # Create README/index.html for rendered view
        mkdir -p "$SITE_DIR/$vibe/README"
        echo "$TEMPLATE" | sed "s|{{VIBE}}|$vibe|g" | sed "s|{{REPO_URL}}|$REPO_URL|g" > "$SITE_DIR/$vibe/README/index.html"
        echo "  $vibe: created README/index.html"
    else
        echo "  $vibe: $SITE_DIR/$vibe not found, skipping"
    fi
done

echo "Done!"
