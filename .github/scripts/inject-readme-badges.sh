#!/bin/bash
# Inject README badges into the vibes list in README.md
#
# Transforms lines like:
#   - [Vibe Name](vibe-dir/) - description
# Into:
#   - [Vibe Name](vibe-dir/) - description <a href="vibe-dir/README" class="readme-badge"><code>README</code></a>
#
# Only adds badge if vibe-dir/README.md exists.

set -e

README_FILE="${1:-README.md}"
TEMP_FILE=$(mktemp)

echo "Injecting README badges into $README_FILE..."

while IFS= read -r line || [ -n "$line" ]; do
    # Check if line looks like a vibe list item: - [Name](dir/) - description
    if echo "$line" | grep -qE '^\s*-\s*\[.+\]\([a-z0-9-]+/\)\s*-\s*.+$'; then
        # Extract the vibe directory using sed
        vibe_dir=$(echo "$line" | sed -E 's/.*\]\(([a-z0-9-]+)\/\).*/\1/')

        # Check if README.md exists for this vibe
        if [ -f "$vibe_dir/README.md" ]; then
            # Append badge to the line
            echo "${line} <a href=\"${vibe_dir}/README\" class=\"readme-badge\"><code>README</code></a>" >> "$TEMP_FILE"
            echo "  $vibe_dir: added README badge"
        else
            # No README, keep original line
            echo "$line" >> "$TEMP_FILE"
            echo "  $vibe_dir: no README.md, skipping"
        fi
    else
        # Not a vibe line, keep as-is
        echo "$line" >> "$TEMP_FILE"
    fi
done < "$README_FILE"

# Replace original file
mv "$TEMP_FILE" "$README_FILE"

echo "Done!"
