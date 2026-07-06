# Global Track Matcher

**[vibes.tlab.sh/global-track-matcher/](https://vibes.tlab.sh/global-track-matcher/)**

Reconcile per-video track identities into shared **global identities** across a set of proofread `.slp` files.

Each video is proofread independently, so `track_1` in one video isn't guaranteed to be the same
individual as `track_1` in another. This tool shows sample frames of every track (cropped to the
animal) so you can eyeball who's who and assign each local track to a global identity, then export
the mapping as CSV.

## Workflow

1. **Name your global identities** — one per line (e.g. `pup_top`, `adult_bottom`). These become colored
   "brushes." Names are saved in the URL so a session config is shareable.
2. **Load your data** — pick your `.slp` folder and your video folder **separately** (they can live in
   different locations). SLP and videos are matched by filename, so the two folder trees don't need to
   match; when a basename repeats across experiments it's disambiguated by parent-folder name. Everything
   is parsed locally in the browser — nothing is uploaded. Pairing can be overridden per-video from a
   dropdown.
3. **Assign** — pick an identity (click, or press `1`–`9`; `0` erases) and click track cards to paint
   them; click again with the same identity to undo. Or click a card's identity label to choose from a
   per-card menu. Each card shows a few representative frames spread across the session, cropped to that
   track's keypoints.
4. **Inspect scale** — click any frame to open a full-frame view with the individual circled (true size
   in context, so pups read small and adults large) alongside a blown-up crop and the measured body-box
   size in pixels.
5. **Export CSV** — columns: `video_file, slp_file, local_track_index, local_track_name, global_identity`
   (paths are relative to the chosen folders, so identical basenames across experiments stay distinct).
   **Import CSV** to resume a previous session.

## Notes

- **Conflict check:** if two local tracks in the *same* video get the same global identity (impossible,
  since they co-occur), the cards are flagged — a quick catch for mis-IDs.
- **SLP reading:** tracks and predicted keypoints are read directly from the `.slp` with
  [h5wasm](https://github.com/usnistgov/h5wasm). If a file doesn't store the video shape/frame rate, both
  are derived from the paired video — dimensions from the video and frame rate measured from decoded
  frames via `requestVideoFrameCallback` (falling back to 30 fps only if measurement isn't available).
  Thumbnails are grabbed by seeking to the right time and cropping to the track's bounding box.
- Reads standard `.slp` files referencing external videos. Supported video types: mp4, mov, avi, mkv,
  webm, m4v. Folder picking uses the File System Access API (Chromium); other browsers fall back to a
  `webkitdirectory` picker.

Single self-contained `index.html`, no build step.
