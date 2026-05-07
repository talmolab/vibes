# GPU Dashboard

**https://vibes.tlab.sh/gpu-dashboard/**

Monitor GPUs across multiple workstations from a single web page. Lightweight agents push stats to a GitHub Gist; the dashboard reads and displays them. No server required.

![GPU Dashboard Screenshot](screenshot.png)

## Features

- Real-time GPU utilization, VRAM, temperature, and power draw per GPU
- GPU state breakdown in summary bar (active / idle / offline)
- GPU fleet view showing model counts across all machines
- Filter by machine type (Workstation / RunAI), search, and sort
- Collapsible machine cards with per-GPU status dots
- CPU usage, RAM, and uptime per machine
- Per-process details (command, user, GPU memory, runtime)
- Peak GPU utilization (30-min rolling window)
- Inference progress tracking with per-camera breakdowns and ETA
- Drag-to-reorder and rename machines
- Auto-pause when tab is hidden, configurable refresh interval
- Filter/sort/collapse state persists in localStorage
- Works with Ubuntu workstations and RunAI pods
- Dark theme, responsive layout

## Architecture

```
Workstation 1  ──push──►                              ◄──read── GitHub Pages
Workstation 2  ──push──►  GitHub Gist (JSON store)    ◄──       Dashboard
RunAI Pod      ──push──►
```

A Python agent on each machine collects `nvidia-smi` + `psutil` stats every 30s and pushes to a GitHub Gist. The static HTML dashboard reads the Gist and renders everything.

## Quick start

1. Create a **secret** [GitHub Gist](https://gist.github.com) and copy the Gist ID
2. Create a [Personal Access Token](https://github.com/settings/tokens) with `gist` scope
3. Edit `agent/config.json` with your Gist ID and token
4. Run `bash agent/install.sh` on each machine
5. Open the dashboard and enter your Gist ID

## Dependencies

- **Dashboard**: None (static HTML)
- **Agent**: Python 3 with `psutil`, `requests`, and `nvidia-smi`
