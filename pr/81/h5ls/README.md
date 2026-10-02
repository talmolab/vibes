# h5ls

**Live:** https://vibes.tlab.sh/h5ls/

Browser-based HDF5 file explorer that lists datasets, shapes, dtypes, and attributes without downloading the entire file.

## Features

- **Local and remote file loading** - Open local HDF5/SLP/NWB files or load from URL (requires CORS)
- **Interactive tree view** - Hierarchical navigation of groups and datasets with expand/collapse controls
- **Metadata inspection** - View dataset shapes, dtypes, sizes, and attributes in detail panel
- **Attribute display** - Full attribute metadata including name, dtype, shape, and values
- **JSON export** - Export complete file structure to JSON with copy-to-clipboard
- **Diagnostic logging** - Real-time operation log with copy functionality
- **Dark theme UI** - Minimal, focused interface for file inspection

## Usage

1. Click **Open Local File** to browse for an HDF5/SLP/NWB file, or click **Load from URL** to enter a remote file URL
2. Browse the file structure in the tree panel on the left
3. Click any dataset or group to view detailed metadata in the right panel
4. Use **Expand All** / **Collapse All** to control tree visibility
5. Open the **Export JSON** section to view or copy the complete file structure
6. Check the **Log** panel for operation details and troubleshooting

## File Support

- HDF5 files (`.h5`, `.hdf5`)
- SLEAP files (`.slp`)
- Neurodata Without Borders files (`.nwb`)

## Dependencies (CDN)

- [h5wasm](https://github.com/usnistgov/h5wasm) - WebAssembly-based HDF5 file reading via Web Worker

## Implementation

The tool uses a Web Worker (`worker.js`) to handle HDF5 file parsing with h5wasm, enabling efficient inspection of large files without blocking the UI. Remote files are accessed via range requests when the server supports CORS and byte-range headers.

## Initial prompt

The initial prompt for this vibe was not recorded. This README was reconstructed based on the implementation.
