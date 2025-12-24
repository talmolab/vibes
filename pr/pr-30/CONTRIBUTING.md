# Contributing

## Principles

1. **Single-file HTML** - Each vibe is one `index.html` with inline CSS/JS
2. **No build step** - No React, no bundlers, no transpilation
3. **CDN dependencies** - Load libraries from jsDelivr/cdnjs when needed
4. **Keep it small** - Target under 300 lines, max 500
5. **Mobile-first** - Responsive design, touch-friendly
6. **URL state** - Use hash/query params for shareable state

## Directory Structure

```
/
├── hello-world/
│   └── index.html    → vibes.tlab.sh/hello-world/
├── another-vibe/
│   └── index.html    → vibes.tlab.sh/another-vibe/
└── ...
```

Each vibe is a directory at the repo root with an `index.html`.

**Reserved names:** The following directory names cannot be used for vibes:
- `pr` - Used for PR preview deployments

## Creating a New Vibe

Use the Claude Code command:
```
/project:new-vibe
```

Or manually:
1. Create a branch: `git checkout -b <vibe-name>`
2. Create `<vibe-name>/index.html`
3. Create `<vibe-name>/README.md` with deployment link and description
4. Add link to the main README
5. Open a PR to `main` (squash merge)

## PR Previews

When you open a PR, a preview deployment is automatically created at:
```
https://vibes.tlab.sh/pr/pr-{PR_NUMBER}/
```

For example, PR #42 would be available at `https://vibes.tlab.sh/pr/pr-42/`.

A comment will be added to the PR with:
- Preview URL
- List of changed vibes (with direct links)
- Commit SHA
- Deployment timestamp

The preview is automatically removed when the PR is closed.

## @claude in Issues

Mention `@claude` in any issue or PR to get AI assistance. Claude can:
- Generate new vibes from descriptions
- Review and improve existing vibes
- Fix bugs and add features

## Local Development

```bash
# Serve locally (runs in background)
npx serve -p 8080 --cors --no-clipboard &

# Open http://localhost:8080/your-vibe/
```

For Python scripts, always use `uv`:
```bash
uv run script.py
```

## Setup (Maintainers)

### DNS (Cloudflare)

```
Type: CNAME
Name: vibes
Content: talmolab.github.io
Proxy: DNS only (gray cloud)
```

### GitHub Pages

- Settings > Pages > Source: Deploy from a branch
- Branch: `gh-pages` / `/ (root)`
- Custom domain: `vibes.tlab.sh`

### Claude Integration

```bash
# Set up OAuth token for @claude mentions
claude /install-github-app
```
