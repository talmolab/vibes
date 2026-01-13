# PyPI Name Checker

**[Live Demo](https://vibes.tlab.sh/pypi-name-checker/)**

Check if a Python package name is available on PyPI with real-time availability checking and alternative name suggestions.

## Features

- **Name availability checking**: Instantly check if a package name is taken on PyPI
- **PEP 503 normalization**: Handles equivalent names (e.g., `my_pkg`, `my-pkg`, `My.Pkg` are all the same)
- **Alternative suggestions**: Generates 20 variations with common prefixes/suffixes (py-, -lib, -utils, etc.)
- **Batch checking**: Checks all suggestions in parallel and sorts available names first
- **Package details**: Shows description and PyPI link for taken packages
- **Shareable links**: URL hash state for bookmarking/sharing searches
- **Mobile responsive**: Works on all screen sizes

## Usage

1. Enter a package name you want to check
2. Press Enter or click "Check"
3. See if the name is available (green) or taken (red)
4. Browse suggested alternatives - available names are sorted to the top

## Initial prompt

```
Build PyPI package name availability checker
```
