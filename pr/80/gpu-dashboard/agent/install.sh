#!/usr/bin/env bash
# GPU Dashboard Agent — install script
# Usage: bash install.sh
set -euo pipefail

echo "=== GPU Dashboard Agent Setup ==="
echo ""

# Allow SCRIPT_DIR override (for curl-based install where files are in /tmp)
SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "$0")" && pwd)}"
CONFIG_DIR="$HOME/.config/gpu-dashboard"
CONFIG_FILE="$CONFIG_DIR/config.json"

# ── Config: load existing or prompt ──────────────────────────────────────────

if [ -f "$CONFIG_FILE" ]; then
    echo "Found existing config at $CONFIG_FILE"
    cat "$CONFIG_FILE"
    echo ""
    read -rp "Use this config? [Y/n]: " USE_EXISTING
    USE_EXISTING=${USE_EXISTING:-Y}
else
    USE_EXISTING="n"
fi

if [[ "$USE_EXISTING" =~ ^[Nn] ]]; then
    # Check for template in repo
    TEMPLATE="$SCRIPT_DIR/config.json"
    if [ -f "$TEMPLATE" ]; then
        echo "Found template config, loading defaults..."
        # Parse defaults from template
        DEFAULT_GIST=$(python3 -c "import json; print(json.load(open('$TEMPLATE'))['gist_id'])" 2>/dev/null || echo "")
        DEFAULT_TOKEN=$(python3 -c "import json; print(json.load(open('$TEMPLATE'))['github_token'])" 2>/dev/null || echo "")
    else
        DEFAULT_GIST=""
        DEFAULT_TOKEN=""
    fi

    if [ -n "$DEFAULT_GIST" ]; then
        read -rp "GitHub Gist ID [$DEFAULT_GIST]: " GIST_ID
        GIST_ID=${GIST_ID:-$DEFAULT_GIST}
    else
        read -rp "GitHub Gist ID: " GIST_ID
    fi

    if [ -n "$DEFAULT_TOKEN" ]; then
        read -rp "GitHub Token [****saved****] (enter to keep): " -s NEW_TOKEN
        echo ""
        GITHUB_TOKEN=${NEW_TOKEN:-$DEFAULT_TOKEN}
    else
        read -rp "GitHub Personal Access Token (gist scope): " -s GITHUB_TOKEN
        echo ""
    fi

    read -rp "Machine label (e.g. 'Blackwell Workstation'): " LABEL
    read -rp "Machine type (workstation/runai) [workstation]: " TYPE
    TYPE=${TYPE:-workstation}
    read -rp "Poll interval in seconds [30]: " INTERVAL
    INTERVAL=${INTERVAL:-30}

    mkdir -p "$CONFIG_DIR"
    cat > "$CONFIG_FILE" <<EOF
{
    "gist_id": "$GIST_ID",
    "github_token": "$GITHUB_TOKEN",
    "machine_label": "$LABEL",
    "machine_type": "$TYPE",
    "interval_seconds": $INTERVAL
}
EOF
    chmod 600 "$CONFIG_FILE"
    echo "Config written to $CONFIG_FILE"
fi

# ── Install agent script ─────────────────────────────────────────────────────

AGENT_SRC="$SCRIPT_DIR/gpu_agent.py"
mkdir -p "$HOME/.local/bin"
cp "$AGENT_SRC" "$HOME/.local/bin/gpu-agent"
chmod +x "$HOME/.local/bin/gpu-agent"
echo "Agent installed to $HOME/.local/bin/gpu-agent"

# ── Check deps ───────────────────────────────────────────────────────────────

echo ""
echo "Checking Python dependencies..."
MISSING=""
python3 -c "import psutil" 2>/dev/null || MISSING="$MISSING psutil"
python3 -c "import requests" 2>/dev/null || MISSING="$MISSING requests"

if [ -n "$MISSING" ]; then
    echo "Missing:$MISSING"
    echo "Trying to install..."
    INSTALLED=false
    # Try pip3
    if ! $INSTALLED && command -v pip3 &>/dev/null; then
        pip3 install --quiet $MISSING 2>/dev/null && INSTALLED=true
    fi
    # Try pip
    if ! $INSTALLED && command -v pip &>/dev/null; then
        pip install --quiet $MISSING 2>/dev/null && INSTALLED=true
    fi
    # Try pip --user (no sudo needed)
    if ! $INSTALLED; then
        pip3 install --user --quiet $MISSING 2>/dev/null && INSTALLED=true
    fi
    # Try uv
    if ! $INSTALLED && command -v uv &>/dev/null; then
        uv pip install $MISSING --system 2>/dev/null && INSTALLED=true || \
        uv pip install $MISSING 2>/dev/null && INSTALLED=true
    fi
    # Try apt (needs sudo)
    if ! $INSTALLED && command -v apt &>/dev/null && command -v sudo &>/dev/null; then
        echo "Trying apt..."
        sudo apt install -y $(echo $MISSING | sed 's/psutil/python3-psutil/g; s/requests/python3-requests/g') 2>/dev/null && INSTALLED=true
    fi
    # Verify
    python3 -c "import psutil; import requests" 2>/dev/null
    if [ $? -ne 0 ]; then
        echo ""
        echo "ERROR: Could not install$MISSING automatically."
        echo "Please install manually with one of:"
        echo "  pip install psutil requests"
        echo "  pip install --user psutil requests"
        echo "  uv pip install psutil requests --system"
        echo "  conda install psutil requests"
        exit 1
    fi
    echo "Dependencies installed."
else
    echo "All dependencies found."
fi

# ── Dry run test ──────────────────────────────────────────────────────────────

echo ""
echo "Testing data collection (dry run)..."
python3 "$HOME/.local/bin/gpu-agent" --dry-run | head -20
echo "..."
echo ""

# ── Install as service or show manual instructions ────────────────────────────

if command -v systemctl &>/dev/null && systemctl --user status >/dev/null 2>&1; then
    echo "Installing systemd user service..."
    mkdir -p "$HOME/.config/systemd/user"

    PYTHON_PATH="$(command -v python3)"
    cat > "$HOME/.config/systemd/user/gpu-agent.service" <<SVCEOF
[Unit]
Description=GPU Dashboard Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$PYTHON_PATH $HOME/.local/bin/gpu-agent
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
SVCEOF

    systemctl --user daemon-reload
    systemctl --user enable gpu-agent
    systemctl --user restart gpu-agent
    echo ""
    echo "Service installed and started!"
    echo "  Check status:  systemctl --user status gpu-agent"
    echo "  View logs:     journalctl --user -u gpu-agent -f"
    echo "  Stop:          systemctl --user stop gpu-agent"
else
    echo "systemd user services not available."
    echo ""
    echo "To run manually (in tmux/screen):"
    echo "  python3 $HOME/.local/bin/gpu-agent"
    echo ""
    echo "To run via cron (every minute, single snapshot):"
    echo "  crontab -e"
    echo "  * * * * * python3 $HOME/.local/bin/gpu-agent --once"
fi

echo ""
echo "=== Setup complete! ==="
