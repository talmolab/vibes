# GitHub Discussion to Markdown

**Live:** https://v.tlab.sh/github-discussion-markdown/

Convert GitHub discussions to structured markdown format for dataset collection and archival purposes.

## Features

- **GraphQL API Integration**: Fetches complete discussion data including metadata, comments, and nested replies
- **Structured Output**: Generates clean, hierarchical markdown with:
  - Discussion metadata (author, date, category, labels, comment count)
  - Original post
  - All comments and nested replies with timestamps
  - Embedded images catalog
- **Image Extraction**: Automatically detects and catalogs images from markdown and HTML syntax
- **Token Persistence**: Saves GitHub token in localStorage for convenience
- **URL State**: Saves discussion URL in URL hash for easy sharing
- **Export Options**: Copy to clipboard or download as `.md` file with auto-generated filename

## Usage

1. **Get a GitHub token**: Create a personal access token at [GitHub Settings](https://github.com/settings/tokens). No scopes are needed for public repositories.

2. **Enter discussion URL**: Paste the URL of any GitHub discussion (e.g., `https://github.com/owner/repo/discussions/123`)

3. **Convert**: Click "Convert to Markdown" to fetch and transform the discussion

4. **Export**: Copy the markdown to clipboard or download it as a file

The tool preserves the full discussion structure with proper attribution and timestamps, making it ideal for archiving discussions or preparing datasets for analysis.

## Initial prompt

The initial prompt for this vibe was not recorded. This README was reconstructed based on the implementation.
