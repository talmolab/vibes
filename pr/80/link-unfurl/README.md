# Link Unfurl Preview

**[Live Demo](https://vibes.tlab.sh/link-unfurl/)**

Preview how a link will appear when shared on social media. Shows both light and dark mode card previews based on OpenGraph and Twitter Card metadata.

## Features

- Fetches and parses OpenGraph (`og:*`) and Twitter Card metadata
- Shows side-by-side light/dark mode previews
- Displays raw metadata table for debugging
- Forces cache refresh on every fetch
- URL state via hash for sharing previews
- Mobile responsive

## Initial prompt

> let's create a new vibe. i want to be able to paste a link and preview how it "unfurls" based on the opengraph or whatever thing. it should show both light and dark modes if available, and should force a cache refresh every time
