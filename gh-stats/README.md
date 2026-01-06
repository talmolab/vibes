# GitHub Stats Dashboard

**[Live Demo](https://vibes.tlab.sh/gh-stats/)**

A visually stunning GitHub contribution stats dashboard that visualizes your commits, lines of code changes, pull requests, and repository activity across all your repositories and organizations.

## Features

- **Commit tracking**: Total commits with daily rate calculation
- **Lines of code**: Additions and deletions visualized over time
- **Pull requests**: Open, merged, and total PR counts with status badges
- **Repository breakdown**: Top repos by contribution with color-coded stats
- **Contribution heatmap**: Stretched GitHub-style calendar with month labels and hover effects
- **Commits by repo timeseries**: Stacked area chart showing top 8 repositories over time
- **Recent PRs list**: Scrollable list with repository, date, and status badges
- **Time range selector**: Preset ranges (7/30/90/365 days) or custom start/end dates
- **Repository filters**: Include/exclude specific repos with click/double-click
- **Persistent settings**: Token and username saved to localStorage
- **Dark theme**: GitHub-inspired dark mode with gradient accents

## Usage

1. Generate a [GitHub Personal Access Token](https://github.com/settings/tokens) with these scopes:
   - `read:user` - Read user profile data
   - `repo` - Access repository data (needed for private repos)
2. Enter your token and GitHub username
3. Select a time range
4. Click "Fetch Stats"

## Initial prompt

```
gh-stats make a visually stunning github contribution stats dashboard that visualizes commits, LOCs (+/-), PRs, repos with configurable time range and included repos and orgs. this is intended to be focal to a single (github) user, regardless of where they are pushing stuff (which orgs or repos). have it work by taking a token and username as input, then fetch and render everything clientside. ultrathink
```
