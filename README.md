# v.tlab.sh

Self-contained HTML vibes (tools/applets) for the web.

Inspired by [simonw/tools](https://github.com/simonw/tools) and the [vibe coding](https://simonwillison.net/2025/Dec/10/html-tools/) philosophy.

## Vibes

- [Hello World](hello-world/) - A simple greeting to test the setup
- [Idle Quest](idle-quest/) - An idle RPG with combat, upgrades, zones, and prestige

---

## About

Each "vibe" is a self-contained HTML application with inline CSS and JavaScript. No build steps, no frameworks, no npm - just HTML that works.

### Principles

1. **Single-file HTML** - Each vibe is one `index.html` with inline CSS/JS
2. **No build step** - No React, no bundlers, no transpilation
3. **CDN dependencies** - Load libraries from jsDelivr/cdnjs when needed
4. **Keep it small** - Target under 300 lines, max 500
5. **Mobile-first** - Responsive design, touch-friendly
6. **URL state** - Use hash/query params for shareable state

### Directory Structure

```
/
├── hello-world/
│   └── index.html    → v.tlab.sh/hello-world/
├── another-vibe/
│   └── index.html    → v.tlab.sh/another-vibe/
└── ...
```

Each vibe is a directory at the repo root with an `index.html`.

## Development

### Creating a New Vibe

Use the Claude skill:
```
/project:new-vibe
```

Or manually:
1. Create a branch: `git checkout -b <vibe-name>`
2. Create `<vibe-name>/index.html`
3. Add link to this README
4. Open a PR to `main` (squash merge)

### @claude in Issues

Mention `@claude` in any issue or PR to get AI assistance. Claude can:
- Generate new vibes from descriptions
- Review and improve existing vibes
- Fix bugs and add features

### Local Development

```bash
# Serve locally
python -m http.server 8000

# Open http://localhost:8000/your-vibe/
```

## Setup

### DNS (Cloudflare)

```
Type: CNAME
Name: v
Content: talmolab.github.io
Proxy: DNS only (gray cloud)
```

### GitHub Pages

- Settings > Pages > Source: GitHub Actions
- Custom domain: `v.tlab.sh`

### Claude Integration

```bash
# Set up OAuth token for @claude mentions
claude /install-github-app
```

## License

BSD-3
