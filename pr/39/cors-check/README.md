# CORS Check

**Live:** https://vibes.tlab.sh/cors-check/

Test if a URL is accessible from the browser and get the right fetch code.

## Features

- Tests direct fetch to check if CORS headers are present
- Tests proxied fetch via [nocors.tlab.sh](https://nocors.tlab.sh) as fallback
- Displays response metadata including status, content-type, and CORS headers
- Provides a recommendation based on results
- Generates ready-to-use JavaScript code for the appropriate fetch method
- URL state preserved in hash for sharing

## Initial prompt

> read nocors.tlab.sh for context. make a new vibe called "cors-check" that uses nocors.tlab.sh versus without it to check the CORS status of a URL and displays informative metadata, as well as a small sample code showing the right way to fetch it in javascript depending on the CORS state.
