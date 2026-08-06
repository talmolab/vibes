# md — Markdown Viewer

**[Live Demo](https://vibes.tlab.sh/md/)**

Append any public markdown URL to the viewer and it renders directly:

```
https://vibes.tlab.sh/md/#https://github.com/talmolab/vibes/blob/main/README.md
```

The point is shareable links: paste a public `.md` URL after the `#` and send the
result to anyone. `?u=<url>` works as an alias.

## Features

- **Recognizes the URL you actually have.** Paste a browser-viewer link — a GitHub
  `blob/` URL, a bare repo, a gist, a Drive share link — and it's rewritten to the
  fetchable raw form automatically. No hunting for the "Raw" button.
- **Sources:** Google Drive, Google Docs, GitHub (blob/raw/tree/bare repo/wiki),
  Gists, GitLab, Gitea/Forgejo/Codeberg, Bitbucket, Hugging Face, Dropbox, HackMD,
  Zenodo, Pastebin, and any URL that serves markdown.
- **GFM rendering** — tables, task lists, strikethrough, autolinks — with lazy-loaded
  syntax highlighting and KaTeX math (fetched only if the document actually contains
  a code fence or math delimiters).
- **Relative links and images resolved** against the source document, so READMEs with
  relative paths work. Relative `.md` links stay inside the viewer; everything else
  points at its human-facing page.
- Rendered title, sticky provenance chip showing the source host, source/rendered
  toggle, copy markdown, copy share link, open original.
- Light/dark via `prefers-color-scheme`, mobile responsive, print styles.

## Security

The page renders untrusted remote markdown, so the HTML is injected only after
`DOMPurify` sanitization with a strict tag/attribute allowlist. Verified against a
hostile-payload probe: inline `<script>`, `<img onerror>`, `<svg onload>`, `<iframe>`,
`<object>`, `<form>`, `<base>`, `<meta http-equiv=refresh>`, `javascript:`/`data:`/
`vbscript:` URLs, `style` attributes, and `id`/`name` DOM clobbering are all
neutralized. Notably the `style` **tag and attribute** are both forbidden —
`<svg><style>` otherwise leaks CSS into page scope in DOMPurify 3.4.13's default
config. Only `data:image/{png,jpeg,gif,webp,avif}` images are allowed (SVG data URLs
are replaced with a placeholder). Targets must be `https:`; IP literals, `localhost`,
and `.internal`/`.local` hosts are refused so the CORS proxy can't be aimed inward.

## Notes from building this

Findings that aren't obvious and cost real time to establish:

- **Google Drive can never be fetched directly from a browser.**
  `drive.usercontent.google.com` returns `200` with `access-control-allow-origin: *`
  to `curl`, but `403` to any request carrying `Sec-Fetch-Site: cross-site` — which
  browsers always send on a cross-origin fetch and JS cannot override. Because
  `vibes.tlab.sh` → `nocors.tlab.sh` is *same-site*, the browser sends
  `Sec-Fetch-Site: same-site`, the proxy forwards it, and Drive accepts. So Drive is
  routed through the proxy unconditionally. Testing CORS with `curl` alone is
  misleading here; send `-H 'Sec-Fetch-Site: cross-site'` to see what a browser sees.
- **`drive.google.com/uc?export=download` is dead** (403). The working endpoint is
  `drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t`.
  `confirm=t` suppresses the large-file virus-scan interstitial, and a
  `resourcekey=` in the original link must be carried through or the request bounces
  to a sign-in page — indistinguishable from a private file.
- **`cdn.jsdelivr.net/npm/marked@18/marked.min.js` is a 404.** marked removed the
  package-root minified bundle in v16; the path in `CLAUDE.md` no longer resolves, and
  the *unpinned* `npm/marked/marked.min.js` silently serves 15.0.12. Use
  `marked@18.0.9/lib/marked.umd.js`. `window.marked` is an object, so `marked.parse(md)`.
- **Gist raw URLs should omit the username:** `gist.githubusercontent.com/raw/<id>`.
  A wrong username 404s, and `gist.github.com` redirects carry no `access-control-*`
  headers at all, so the browser dies at the first hop — the URL must be rebuilt, not
  followed. Bare `/raw` on a multi-file gist returns one unpredictable file, so the
  Gists API picks the right one (its response includes content inline).
- **`content-disposition` is unreadable from JS.** It isn't CORS-safelisted and Drive's
  `access-control-expose-headers` doesn't include it, so the filename can't be used for
  the title. Title comes from the first `<h1>`, then frontmatter, then the URL path.
- **DOMPurify's `SANITIZE_NAMED_PROPS` silently breaks every in-page anchor** — it
  renames a content `id="install"` to `user-content-install` but leaves `href="#install"`
  alone. Headings are re-slugged to `h-<slug>` and anchors remapped through that table.
- **Smooth scrolling can't be relied on.** Both `scrollIntoView({behavior:'smooth'})`
  and CSS `scroll-behavior: smooth` scrolled nowhere in a Chrome instance with
  reduced-motion *off*, so anchor jumps use an instant scroll.
- **In-page anchors must not touch `location.hash`** — the hash holds the source URL,
  so writing `#h-install` to it would destroy the document identity and reload.
- `marked`'s inline emphasis scanner is super-linear, so a long run of `*` can hang the
  tab; documents with pathological emphasis counts fall back to plain text.

The nocors proxy only serves `*.tlab.sh` origins, so proxy-backed sources (Drive,
GitLab, Codeberg, Pastebin, and the generic fallback) can't be tested from
`localhost` — the page detects this and says so instead of showing a dead retry button.

This file is 559 lines, over the 500-line guideline in `CLAUDE.md`. The overage is the
URL rule table, the sanitizer allowlist, and the per-failure-mode error copy; trimming
to 500 would mean dropping either provider coverage or XSS hardening.

## Initial prompt

> can you make a /new-vibe that lets me take urls like
> `https://drive.google.com/open?id=1wuB-ahknVbXYEqGiWICX0WndO_ajcAzd&usp=drive_fs` or
> gists or github links to markdown files (raw or browser viewer) and just renders the
> markdown directly? the goal is to be able to share links easily by just appending
> public https links to the vibe url and doing some light parsing and appropriate rendering
