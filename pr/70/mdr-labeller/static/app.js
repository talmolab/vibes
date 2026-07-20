"use strict";
// Lumon refinement labeller — grid of clips; hover to enlarge & play; drag into a bin.
// z = fullscreen the hovered clip; hover a bin to see its filed clips and drag them back out.

const grid = document.getElementById("grid");
const binsEl = document.getElementById("bins");
const ghost = document.getElementById("ghost");
const toastEl = document.getElementById("toast");
const overlay = document.getElementById("overlay");
const flyout = document.getElementById("flyout");
const flyoutTitle = document.getElementById("flyoutTitle");
const flyoutGrid = document.getElementById("flyoutGrid");
const lightbox = document.getElementById("lightbox");
const lbVideo = document.getElementById("lightboxVideo");
const lbMeta = document.getElementById("lightboxMeta");

let labels = [];
let labelDisplay = {};
const tilesById = new Map();
const binByLabel = new Map();
let hoveredId = null;
let lightboxId = null;
let flyoutBehavior = null;
let flyoutTimer = null;

const drag = { el: null, id: null, sx: 0, sy: 0, active: false, ph: null };   // live tile drag
const mdrag = { el: null, id: null, ev: null, sx: 0, sy: 0, active: false, from: null }; // flyout mini drag

const display = (lab) => labelDisplay[lab] || lab;
const camOf = (stem) => { const p = String(stem).split("."); return p.length > 1 ? p[1] : "?"; };

// ---------------- boot ----------------
init();
async function init() {
  const cfg = await (await fetch("/api/config")).json();
  labels = cfg.labels;
  labelDisplay = cfg.label_display || {};
  document.getElementById("fileCode").textContent = "FILE  “" + cfg.file_code + "”";
  document.getElementById("fileSub").textContent = cfg.file_sub || "";
  document.documentElement.style.setProperty("--tile", (cfg.grid?.tile_px || 132) + "px");
  document.documentElement.style.setProperty("--zoom", cfg.grid?.zoom || 2.7);
  document.documentElement.style.setProperty("--nbins", labels.length);
  buildBins();
  applyState(cfg.counts, cfg.done, cfg.total);

  const { events } = await (await fetch("/api/events?limit=80")).json();
  events.forEach(addTile);
  if (!events.length && cfg.done >= cfg.total) showComplete();

  document.getElementById("reloadBtn").addEventListener("click", () => location.reload());
  window.addEventListener("keydown", onKey);
  flyout.addEventListener("pointerenter", () => clearTimeout(flyoutTimer));
  flyout.addEventListener("pointerleave", scheduleCloseFlyout);
  lightbox.addEventListener("click", (e) => { if (e.target === lightbox) closeLightbox(); });
}

function buildBins() {
  labels.forEach((lab, i) => {
    const b = document.createElement("button");
    b.className = "bin"; b.dataset.label = lab;
    b.setAttribute("aria-label", `${lab} bin (key ${i + 1}); hover to view filed clips`);
    b.innerHTML =
      `<div class="bin-fill"></div>
       <div class="bin-head"><span class="bin-num">${String(i + 1).padStart(2, "0")}</span><span class="bin-count">0</span></div>
       <div class="bin-name">${display(lab)}</div>`;
    b.addEventListener("click", () => { if (hoveredId != null) labelTile(hoveredId, lab); });
    b.addEventListener("pointerenter", () => openFlyout(b, lab));
    b.addEventListener("pointerleave", scheduleCloseFlyout);
    binsEl.appendChild(b);
    binByLabel.set(lab, b);
  });
}

// ---------------- tiles ----------------
function addTile(ev) {
  const el = document.createElement("div");
  el.className = "tile"; el.dataset.id = ev.id; el.tabIndex = 0; el.__ev = ev;
  el.innerHTML =
    `<img class="poster" alt="" draggable="false">
     <div class="shimmer"></div>
     <div class="dyad">${ev.dyad || ""}</div>
     <div class="meta">${ev.cohort} · cam ${camOf(ev.stem)}<br>f${ev.cs} · ${ev.cond || ""}${ev.subtype ? " · " + ev.subtype : ""}</div>`;
  const img = el.querySelector("img");
  img.onerror = () => el.classList.add("unavailable");
  img.src = ev.poster;
  el.addEventListener("pointerenter", () => { if (!drag.active && !mdrag.active) zoomIn(el); });
  el.addEventListener("pointerleave", () => { if (!drag.active) zoomOut(el); });
  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("focus", () => { hoveredId = ev.id; });
  el.addEventListener("blur", () => { if (hoveredId === ev.id) hoveredId = null; });
  tilesById.set(ev.id, el);
  grid.appendChild(el);
}

function zoomIn(el) {
  hoveredId = +el.dataset.id;
  el.classList.add("zoom");
  if (el.classList.contains("unavailable")) return;
  let v = el.querySelector("video");
  if (!v) {
    v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true; v.preload = "auto";
    el.classList.add("loading");
    v.addEventListener("canplay", () => {
      el.classList.remove("loading");
      if (el.classList.contains("zoom") || el.classList.contains("dragging-live")) {
        el.classList.add("playing"); v.play().catch(() => {});
      }
    });
    v.addEventListener("error", () => el.classList.remove("loading"));
    v.src = el.__ev.clip;
    el.appendChild(v);
  } else {
    el.classList.add("playing"); v.play().catch(() => {});
  }
}

function zoomOut(el) {
  el.classList.remove("zoom", "playing");
  const v = el.querySelector("video");
  if (v) v.pause();
  if (hoveredId === +el.dataset.id) hoveredId = null;
}

// ---------------- live tile drag (keeps the same video playing) ----------------
function onPointerDown(e) {
  if (e.button !== 0) return;
  drag.el = e.currentTarget; drag.id = +drag.el.dataset.id;
  drag.sx = e.clientX; drag.sy = e.clientY; drag.active = false;
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
}

function onPointerMove(e) {
  if (!drag.el) return;
  if (!drag.active) {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 8) return;
    startLiveDrag(drag.el);
  }
  drag.el.style.left = e.clientX + "px";
  drag.el.style.top = e.clientY + "px";
  highlightBinAt(e.clientX, e.clientY);
}

function startLiveDrag(el) {
  drag.active = true;
  closeFlyoutNow();
  if (!el.classList.contains("zoom")) zoomIn(el);   // ensure it's playing
  const ph = document.createElement("div");
  ph.className = "tile placeholder";
  el.parentNode.insertBefore(ph, el);
  drag.ph = ph;
  el.classList.remove("zoom");
  el.classList.add("dragging-live");
  document.body.appendChild(el);                     // fixed positioning vs viewport, no grid reflow
}

function cancelLiveDrag() {
  if (drag.ph) { drag.ph.parentNode.insertBefore(drag.el, drag.ph); drag.ph.remove(); drag.ph = null; }
  drag.el.classList.remove("dragging-live");
  drag.el.style.left = ""; drag.el.style.top = "";
  zoomOut(drag.el);
}

function onPointerUp(e) {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  if (drag.active) {
    const bin = binAt(e.clientX, e.clientY);
    clearBinHighlight();
    if (bin) {
      if (drag.ph) { drag.ph.remove(); drag.ph = null; }
      labelTile(drag.id, bin.dataset.label);
    } else {
      cancelLiveDrag();
    }
  }
  drag.el = null; drag.active = false; drag.ph = null;
}

function binAt(x, y) { const el = document.elementFromPoint(x, y); return el ? el.closest(".bin") : null; }
function isOverGrid(x, y) { const el = document.elementFromPoint(x, y); return !!(el && el.closest(".stage")); }
function highlightBinAt(x, y) { clearBinHighlight(); const b = binAt(x, y); if (b) b.classList.add("over"); }
function clearBinHighlight() { binsEl.querySelectorAll(".bin.over").forEach((b) => b.classList.remove("over")); }

// ---------------- labeling ----------------
async function labelTile(id, behavior) {
  const el = tilesById.get(id);
  if (!el) return;
  tilesById.delete(id);
  if (hoveredId === id) hoveredId = null;
  el.classList.remove("zoom");
  el.classList.add("gone");
  setTimeout(() => el.remove(), 320);

  let j;
  try {
    j = await post("/api/label", { id, behavior });
  } catch (_) { toast("connection lost"); return; }
  if (j.error) { toast("label rejected"); return; }
  applyState(j.counts, j.done, j.total);
  flashBin(behavior);
  toast("refined → " + display(behavior));
  if (j.next) addTile(j.next);
  if (j.done >= j.total) showComplete();
}

async function relabelEvent(id, behavior) {
  const j = await post("/api/relabel", { id, behavior });
  if (j.error) return;
  applyState(j.counts, j.done, j.total);
  flashBin(behavior);
  toast("re-filed → " + display(behavior));
  refreshFlyout();
}

async function unlabelEvent(id) {
  const j = await post("/api/unlabel", { id });
  if (j.error) return;
  applyState(j.counts, j.done, j.total);
  toast("un-filed");
  if (j.event) addTile(j.event);
  refreshFlyout();
}

function applyState(counts, done, total) {
  const maxc = Math.max(6, ...Object.values(counts));
  labels.forEach((lab) => {
    const b = binByLabel.get(lab);
    if (!b) return;
    const n = counts[lab] || 0;
    b.querySelector(".bin-count").textContent = n;
    b.querySelector(".bin-fill").style.height = Math.min(100, (n / maxc) * 100) + "%";
  });
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById("topBar").style.width = pct + "%";
  document.getElementById("topPct").textContent = pct + "%";
  document.getElementById("counter").textContent = `${done} / ${total} refined`;
  document.querySelector(".progress").setAttribute("aria-valuenow", pct);
}

function flashBin(behavior) {
  const b = binByLabel.get(behavior);
  if (!b) return;
  b.classList.remove("flash"); void b.offsetWidth; b.classList.add("flash");
}

// ---------------- bin flyout: already-filed clips, drag back out ----------------
async function openFlyout(binEl, behavior) {
  if (drag.active || mdrag.active) return;
  clearTimeout(flyoutTimer);
  flyoutBehavior = behavior;
  await loadFlyout(behavior);
  positionFlyout(binEl);
}

async function loadFlyout(behavior) {
  let events = [];
  try {
    ({ events } = await (await fetch(`/api/binned?behavior=${encodeURIComponent(behavior)}`)).json());
  } catch (_) { return; }
  if (flyoutBehavior !== behavior) return;
  flyoutTitle.innerHTML = `<b>${display(behavior)}</b> — ${events.length} filed · drag a clip out to re-file`;
  flyoutGrid.innerHTML = "";
  if (!events.length) {
    flyoutGrid.innerHTML = '<div class="flyout-empty">no clips filed here yet</div>';
  } else {
    events.forEach((ev) => flyoutGrid.appendChild(makeMini(ev)));
  }
}

function refreshFlyout() {
  if (flyout.classList.contains("show") && flyoutBehavior) loadFlyout(flyoutBehavior);
}

function positionFlyout(binEl) {
  const r = binEl.getBoundingClientRect();
  flyout.style.top = "auto";
  flyout.style.bottom = (window.innerHeight - r.top + 8) + "px";
  flyout.classList.add("show");
  const fr = flyout.getBoundingClientRect();
  let left = r.left;
  if (left + fr.width > window.innerWidth - 10) left = window.innerWidth - 10 - fr.width;
  flyout.style.left = Math.max(10, left) + "px";
}

function scheduleCloseFlyout() {
  clearTimeout(flyoutTimer);
  flyoutTimer = setTimeout(closeFlyoutNow, 200);
}
function closeFlyoutNow() { flyout.classList.remove("show"); flyoutBehavior = null; }

function makeMini(ev) {
  const el = document.createElement("div");
  el.className = "mini"; el.dataset.id = ev.id; el.__ev = ev;
  el.innerHTML = `<img src="${ev.poster}" alt="" draggable="false">`;
  el.addEventListener("pointerdown", onMiniDown);
  return el;
}

function onMiniDown(e) {
  if (e.button !== 0) return;
  mdrag.el = e.currentTarget; mdrag.id = +mdrag.el.dataset.id; mdrag.ev = mdrag.el.__ev;
  mdrag.from = flyoutBehavior; mdrag.sx = e.clientX; mdrag.sy = e.clientY; mdrag.active = false;
  window.addEventListener("pointermove", onMiniMove);
  window.addEventListener("pointerup", onMiniUp);
  e.preventDefault();
}

function onMiniMove(e) {
  if (!mdrag.el) return;
  if (!mdrag.active) {
    if (Math.hypot(e.clientX - mdrag.sx, e.clientY - mdrag.sy) < 8) return;
    mdrag.active = true;
    mdrag.el.classList.add("dragging");
    clearTimeout(flyoutTimer);
    showGhost(mdrag.ev.poster);
  }
  moveGhost(e.clientX, e.clientY);
  highlightBinAt(e.clientX, e.clientY);
}

function onMiniUp(e) {
  window.removeEventListener("pointermove", onMiniMove);
  window.removeEventListener("pointerup", onMiniUp);
  if (mdrag.active) {
    hideGhost(); clearBinHighlight();
    const bin = binAt(e.clientX, e.clientY);
    if (bin && bin.dataset.label !== mdrag.from) relabelEvent(mdrag.id, bin.dataset.label);
    else if (bin) mdrag.el.classList.remove("dragging");            // dropped on same bin
    else if (isOverGrid(e.clientX, e.clientY)) unlabelEvent(mdrag.id);
    else mdrag.el.classList.remove("dragging");
  }
  mdrag.el = null; mdrag.active = false;
}

function showGhost(src) {
  ghost.querySelector("img")?.remove();
  const g = document.createElement("img"); g.src = src; ghost.appendChild(g);
  ghost.style.display = "block";
}
function moveGhost(x, y) { ghost.style.left = x + "px"; ghost.style.top = y + "px"; }
function hideGhost() { ghost.style.display = "none"; }

// ---------------- z-to-fullscreen lightbox ----------------
function openLightbox(id) {
  const el = tilesById.get(id);
  if (!el || el.classList.contains("unavailable")) return;
  lightboxId = id;
  const ev = el.__ev;
  lbVideo.src = ev.clip; lbVideo.play().catch(() => {});
  lbMeta.textContent = `${ev.cohort} · cam ${camOf(ev.stem)} · f${ev.cs} · ${ev.dyad}`;
  lightbox.classList.add("show");
}
function closeLightbox() {
  lightbox.classList.remove("show");
  lbVideo.pause(); lbVideo.removeAttribute("src"); lbVideo.load();
  lightboxId = null;
}

// ---------------- keyboard ----------------
function onKey(e) {
  if (e.key === "z" || e.key === "Z") {
    if (lightboxId != null) closeLightbox();
    else if (hoveredId != null) openLightbox(hoveredId);
    e.preventDefault();
    return;
  }
  if (e.key === "Escape") { if (lightboxId != null) { closeLightbox(); e.preventDefault(); } return; }
  const idx = labels.findIndex((_, i) => String(i + 1) === e.key);
  if (idx < 0) return;
  if (lightboxId != null) { const id = lightboxId; closeLightbox(); labelTile(id, labels[idx]); e.preventDefault(); }
  else if (hoveredId != null) { labelTile(hoveredId, labels[idx]); e.preventDefault(); }
}

// ---------------- misc ----------------
let toastT;
function toast(msg) {
  toastEl.textContent = msg; toastEl.classList.add("show");
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove("show"), 1100);
}
async function post(url, body) {
  return (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
}
function showComplete() { overlay.classList.add("show"); }
