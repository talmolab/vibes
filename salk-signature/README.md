# Salk Email Signature Generator

🔗 **Live:** [https://vibes.tlab.sh/salk-signature/](https://vibes.tlab.sh/salk-signature/)

A self-contained tool for generating a branded Salk Institute email signature. Fill in your
details, watch the live preview update, and copy a ready-to-paste signature into Outlook,
Apple Mail, or Gmail.

## Features

- **Flexible line builder** — build the signature line by line instead of with fixed fields:
  - **Pick a type per line**: Name, Title, Lab / Department, Office phone, Mobile, Email,
    Website / Link, or **Custom text** (freeform).
  - **Add as many lines as you want** (e.g. several title lines) with the **+ Add line** button.
  - **Reorder** by dragging the ⠿ handle (desktop) or with the ↑ / ↓ buttons (touch-friendly),
    and remove any line with ✕.
  - Empty lines are simply omitted from the output.
- **Live preview** rendered from a pure `renderSignature()` over the line list — the exact
  string that lands on the clipboard (no DOM scraping).
- **Rich-HTML copy** using the modern Clipboard API (`ClipboardItem` with `text/html` +
  `text/plain`), falling back to the legacy `execCommand('copy')` + Selection/Range path so it
  works across browsers and email clients.
- **Table-based signature** with fully inlined styles for maximum email-client compatibility
  (Outlook's Word rendering engine handles tables far better than div/flex layouts).
- **Standard Salk footer** (institute name, address, `www.salk.edu`) always included, with
  toggles for the **Salk logo** and **social links**.
- **`tel:` / `mailto:` links** with explicit inline color + `text-decoration` so clients don't
  re-style them.
- **Pre-uppercased** title/lab text (rather than relying on CSS `text-transform`, which Outlook
  honors inconsistently).
- **Office phone** defaults to the main Salk number `(858) 453-4100` when left blank.
- **Per-client guidance tabs** (Outlook / Apple Mail / Gmail), including the Apple Mail
  "uncheck *Always match my default message font*" caveat.
- **Raw HTML source view** and a "Copy HTML source" button for power users.
- **Shareable signature** — the full line list + footer toggles are encoded (base64 JSON) in the
  URL hash, so a link round-trips the entire signature.

## Design tokens

| Token | Value |
| --- | --- |
| Brand text color | `#6D6E71` |
| Background | `#fff` |
| Font | `Arial, sans-serif` |
| Base size | `12px` (title/lab `10px` uppercase) |
| Line height | `16px` |
| Logo | `75×50` from `salk.edu/wp-content/uploads/2026/03/26-salk-signature-tag-logo.png` |
| Address | `10010 N Torrey Pines Rd | La Jolla, CA 92037` |
| Social order | Facebook · Instagram · LinkedIn · YouTube · X (` | ` separated) |

## Initial prompt

> Reverse-engineer the Salk "Interact" CMS email-signature generator and build a better,
> standalone single-file version. The original is client-side HTML+JS: a form collects name,
> title, email plus six optional toggles (lab/department, extension, mobile, lab website, logo,
> social), a live `#signaturePreview` node re-renders a single-cell `<table>` signature on every
> input, and a copy button selects that node and runs `document.execCommand('copy')` to copy rich
> HTML. Improve it: a pure `renderSignature(state)` template producing the exact `text/html`
> clipboard payload, modern `ClipboardItem` copy with an `execCommand` fallback, a plain-text
> alternative, success/error toasts, `tel:`/`mailto:` links, pre-uppercased title/lab text,
> configurable office phone, per-client paste guidance, and a raw-HTML export view. Reuse the
> exact design tokens (brand `#6D6E71`, Arial 12px, title/lab 10px uppercase, line-height 16px,
> 75×50 hosted logo, the Salk address and `www.salk.edu`).
