// --- base maps -----------------------------------------------------------
// Kept as plain config so the JPG export can re-fetch the same tiles itself.
const BASE_LAYERS = {
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    subdomains: "abcd",
    maxZoom: 20,
    background: "#0e1116",
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    credit: "© OpenStreetMap © CARTO",
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    subdomains: "",
    maxZoom: 19,
    background: "#1b1d1a",
    attribution:
      'Tiles &copy; <a href="https://www.esri.com/">Esri</a> — Source: Esri, Maxar, Earthstar Geographics',
    credit: "Tiles © Esri, Maxar, Earthstar Geographics",
  },
};

let currentBase = "dark";

const map = L.map("map", { zoomControl: true }).setView([50.06, 19.94], 6);

let baseLayer = null;
function setBaseLayer(key) {
  const cfg = BASE_LAYERS[key];
  if (!cfg) return;
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = L.tileLayer(cfg.url, {
    attribution: cfg.attribution,
    subdomains: cfg.subdomains,
    maxZoom: cfg.maxZoom,
    crossOrigin: true, // required so the export canvas isn't tainted
  }).addTo(map);
  currentBase = key;

  document.getElementById("base-dark").classList.toggle("active", key === "dark");
  document.getElementById("base-sat").classList.toggle("active", key === "satellite");
}
setBaseLayer("dark");

const markerLayer = L.layerGroup().addTo(map);
const markersById = new Map();
let currentList = []; // sightings currently shown (drives the legend + export)

// --- per-species colour ---------------------------------------------------
// A curated palette that reads well on dark tiles. Colours are handed out by
// each species' position in the sorted list of known names, so two different
// species never share a colour (until the palette wraps at 14).
const PALETTE = [
  "#e6584f", "#f0883e", "#f2c744", "#9fd356", "#4fc46a", "#35c9a5", "#3fbdd8",
  "#4f8ff0", "#7c6ff0", "#a86ce0", "#e06cc4", "#f07396", "#b58a5a", "#8fa3b8",
];

// Shape is the second dimension: 14 colours x 5 shapes = 70 distinct markers,
// so species stay tellable apart well past the point where colour alone repeats.
const SHAPES = ["circle", "square", "triangle", "diamond", "hexagon"];

let styleByName = new Map();

function assignStyles(names) {
  styleByName = new Map();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const n = sorted.length;

  sorted.forEach((name, i) => {
    let color, shape;
    if (n <= PALETTE.length) {
      // Few species: every one gets its own colour, spread across the palette
      // so neighbours are not near-identical hues. All circles.
      color = PALETTE[Math.floor((i * PALETTE.length) / Math.max(n, 1))];
      shape = "circle";
    } else {
      // Many species: cycle shape fastest so adjacent entries differ at a
      // glance, and step the colour every full pass. (colour, shape) pairs are
      // unique until 14 x 5 species.
      shape = SHAPES[i % SHAPES.length];
      color = PALETTE[Math.floor(i / SHAPES.length) % PALETTE.length];
    }
    styleByName.set(name.trim().toLowerCase(), { color, shape });
  });
}

function styleForName(name) {
  const key = String(name).trim().toLowerCase();
  const known = styleByName.get(key);
  if (known) return known;

  // Fallback for a name not yet in /api/names (stable hash).
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h = h >>> 0;
  return {
    color: PALETTE[h % PALETTE.length],
    shape: SHAPES[Math.floor(h / PALETTE.length) % SHAPES.length],
  };
}

function colorForName(name) {
  return styleForName(name).color;
}

// --- shape rendering ------------------------------------------------------
// SVG for the DOM (markers, legend, list); a canvas path for the JPG export.
const SHAPE_POINTS = {
  square: "3,3 17,3 17,17 3,17",
  triangle: "10,2 18,16.5 2,16.5",
  diamond: "10,1 18.5,10 10,19 1.5,10",
  hexagon: "10,1.5 17.4,5.75 17.4,14.25 10,18.5 2.6,14.25 2.6,5.75",
};

function shapeSvg(name, size = 14) {
  const { color, shape } = styleForName(name);
  const body =
    shape === "circle"
      ? `<circle cx="10" cy="10" r="8" />`
      : `<polygon points="${SHAPE_POINTS[shape]}" />`;
  return (
    `<svg class="swatch" width="${size}" height="${size}" viewBox="0 0 20 20" ` +
    `fill="${color}" stroke="rgba(255,255,255,0.85)" stroke-width="1.5">${body}</svg>`
  );
}

function shapePath(ctx, shape, x, y, r) {
  ctx.beginPath();
  if (shape === "square") {
    ctx.rect(x - r * 0.85, y - r * 0.85, r * 1.7, r * 1.7);
  } else if (shape === "triangle") {
    ctx.moveTo(x, y - r * 1.1);
    ctx.lineTo(x + r * 1.05, y + r * 0.75);
    ctx.lineTo(x - r * 1.05, y + r * 0.75);
    ctx.closePath();
  } else if (shape === "diamond") {
    ctx.moveTo(x, y - r * 1.2);
    ctx.lineTo(x + r * 1.1, y);
    ctx.lineTo(x, y + r * 1.2);
    ctx.lineTo(x - r * 1.1, y);
    ctx.closePath();
  } else if (shape === "hexagon") {
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i - 30);
      const px = x + r * Math.cos(a);
      const py = y + r * Math.sin(a);
      if (i) ctx.lineTo(px, py);
      else ctx.moveTo(px, py);
    }
    ctx.closePath();
  } else {
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
}

function markerIcon(name) {
  return L.divIcon({
    className: "species-marker",
    html: shapeSvg(name, 20),
    iconSize: [20, 20],
    iconAnchor: [10, 10],
    popupAnchor: [0, -11],
  });
}

// --- elements ------------------------------------------------------------
const filterInput = document.getElementById("filter-name");
const clearFilterBtn = document.getElementById("clear-filter");
const refreshBtn = document.getElementById("refresh");
const nameOptions = document.getElementById("name-options");
const countEl = document.getElementById("count");
const legendPanel = document.getElementById("legend-panel");
const legendEl = document.getElementById("legend");
const listEl = document.getElementById("sight-list");
const form = document.getElementById("add-form");
const formMsg = document.getElementById("form-msg");
const submitBtn = document.getElementById("submit-btn");
const latInput = document.getElementById("f-lat");
const lngInput = document.getElementById("f-lng");
const imageInput = document.getElementById("f-image");

let pinMarker = null;

function dropPin(lat, lng) {
  const latlng = L.latLng(lat, lng);
  if (pinMarker) pinMarker.setLatLng(latlng);
  else
    pinMarker = L.circleMarker(latlng, {
      radius: 9,
      color: "#e0803a",
      weight: 2,
      dashArray: "4 3",
      fill: false,
    }).addTo(map);
  map.setView(latlng, Math.max(map.getZoom(), 13));
}

// --- data loading --------------------------------------------------------
async function loadNames() {
  const res = await fetch("/api/names");
  const names = await res.json();
  assignStyles(names);
  nameOptions.innerHTML = names
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

async function loadMushrooms() {
  const q = filterInput.value.trim();
  const url = q ? `/api/mushrooms?name=${encodeURIComponent(q)}` : "/api/mushrooms";
  const res = await fetch(url);
  const list = await res.json();
  currentList = list;

  renderMarkers(list);
  renderLegend(list);
  renderList(list);

  countEl.textContent =
    `${list.length} sighting${list.length === 1 ? "" : "s"}` +
    (q ? ` matching “${q}”` : "");
}

// --- map markers ---------------------------------------------------------
function renderMarkers(list) {
  markerLayer.clearLayers();
  markersById.clear();
  const bounds = [];

  for (const m of list) {
    const marker = L.marker([m.lat, m.lng], {
      icon: markerIcon(m.name),
      title: m.name,
    });
    marker.bindPopup(popupHtml(m));
    marker.on("popupopen", (e) => {
      const btn = e.popup.getElement().querySelector(".del");
      if (btn) btn.onclick = () => deleteMushroom(m.id);
    });
    marker.addTo(markerLayer);
    markersById.set(m.id, marker);
    bounds.push([m.lat, m.lng]);
  }

  if (bounds.length) map.fitBounds(bounds, { padding: [50, 50], maxZoom: 13 });
}

function popupHtml(m) {
  const img = m.imageUrl
    ? `<img src="${m.imageUrl}" alt="${escapeHtml(m.name)}" />`
    : "";
  const notes = m.notes ? `<div class="notes">${escapeHtml(m.notes)}</div>` : "";
  const when = m.takenAt
    ? `📸 Taken ${new Date(m.takenAt).toLocaleString()}`
    : `Logged ${new Date(m.createdAt).toLocaleString()}`;
  return `
    <div class="popup">
      <h3>${shapeSvg(m.name, 13)}${escapeHtml(m.name)}</h3>
      ${img}
      ${notes}
      <div class="meta">${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</div>
      <div class="meta">${when}</div>
      <button class="del">Delete</button>
    </div>`;
}

// --- legend (species -> colour) ------------------------------------------
function renderLegend(list) {
  const counts = new Map();
  for (const m of list) counts.set(m.name, (counts.get(m.name) || 0) + 1);

  if (counts.size === 0) {
    legendPanel.hidden = true;
    legendEl.innerHTML = "";
    return;
  }
  legendPanel.hidden = false;

  legendEl.innerHTML = [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(
      ([name, n]) => `
        <li class="legend-item" data-name="${escapeHtml(name)}" title="Filter by ${escapeHtml(name)}">
          ${shapeSvg(name, 13)}
          <span class="legend-name">${escapeHtml(name)}</span>
          <span class="badge">${n}</span>
        </li>`
    )
    .join("");

  legendEl.querySelectorAll(".legend-item").forEach((li) => {
    li.onclick = () => {
      filterInput.value = li.dataset.name;
      loadMushrooms();
    };
  });
}

// --- sightings list ------------------------------------------------------
function renderList(list) {
  if (list.length === 0) {
    listEl.innerHTML = `<li class="empty muted">No sightings yet.</li>`;
    return;
  }

  listEl.innerHTML = list
    .map((m) => {
      const when = m.takenAt
        ? new Date(m.takenAt).toLocaleDateString()
        : new Date(m.createdAt).toLocaleDateString();
      const thumb = m.imageUrl
        ? `<img class="thumb" src="${m.imageUrl}" alt="" />`
        : `<span class="thumb thumb-empty"></span>`;
      return `
        <li class="sight-item" data-id="${m.id}">
          ${thumb}
          <span class="sight-body">
            <span class="sight-name">
              ${shapeSvg(m.name, 12)}
              ${escapeHtml(m.name)}
            </span>
            <span class="sight-meta">${when} · ${m.lat.toFixed(3)}, ${m.lng.toFixed(3)}</span>
          </span>
        </li>`;
    })
    .join("");

  listEl.querySelectorAll(".sight-item").forEach((li) => {
    li.onclick = () => focusSighting(li.dataset.id);
  });
}

function focusSighting(id) {
  const marker = markersById.get(id);
  if (!marker) return;

  map.setView(marker.getLatLng(), Math.max(map.getZoom(), 13));
  // Opening mid-pan can leave the popup unrendered, so open once the map
  // settles — with a timed fallback in case no move (and no moveend) occurs.
  map.once("moveend", () => marker.openPopup());
  setTimeout(() => {
    if (!marker.isPopupOpen()) marker.openPopup();
  }, 350);

  listEl.querySelectorAll(".sight-item").forEach((li) => {
    li.classList.toggle("active", li.dataset.id === id);
  });
}

async function deleteMushroom(id) {
  if (!confirm("Delete this sighting?")) return;
  await fetch(`/api/mushrooms/${id}`, { method: "DELETE" });
  await refresh();
}

// --- add form ------------------------------------------------------------
map.on("click", (e) => {
  latInput.value = e.latlng.lat.toFixed(6);
  lngInput.value = e.latlng.lng.toFixed(6);
  dropPin(e.latlng.lat, e.latlng.lng);
});

// When a photo is chosen, try to read GPS from its EXIF and auto-fill coords.
imageInput.addEventListener("change", async () => {
  const file = imageInput.files[0];
  if (!file) return;
  formMsg.textContent = "Reading photo location…";
  try {
    const fd = new FormData();
    fd.append("image", file);
    const res = await fetch("/api/exif", { method: "POST", body: fd });
    const data = await res.json();
    const bits = [];
    if (data.hasLocation) {
      latInput.value = data.lat.toFixed(6);
      lngInput.value = data.lng.toFixed(6);
      dropPin(data.lat, data.lng);
      bits.push("📍 Location");
    }
    if (data.takenAt) bits.push("📸 " + new Date(data.takenAt).toLocaleDateString());
    formMsg.textContent = bits.length
      ? bits.join(" · ") + " read from photo"
      : "No GPS in photo — click the map to set location";
  } catch {
    formMsg.textContent = "";
  }
  setTimeout(() => (formMsg.textContent = ""), 3000);
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  submitBtn.disabled = true;
  formMsg.textContent = "Saving…";
  try {
    const fd = new FormData(form);
    const res = await fetch("/api/mushrooms", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save");
    form.reset();
    if (pinMarker) {
      map.removeLayer(pinMarker);
      pinMarker = null;
    }
    formMsg.textContent = "✓ Added!";
    await refresh();
  } catch (err) {
    formMsg.textContent = "⚠ " + err.message;
  } finally {
    submitBtn.disabled = false;
    setTimeout(() => (formMsg.textContent = ""), 2500);
  }
});

// --- filter & refresh ----------------------------------------------------
let debounce;
filterInput.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(loadMushrooms, 250);
});
clearFilterBtn.addEventListener("click", () => {
  filterInput.value = "";
  loadMushrooms();
});

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  const original = refreshBtn.textContent;
  refreshBtn.textContent = "⟳ Refreshing…";
  try {
    await refresh();
  } finally {
    refreshBtn.textContent = original;
    refreshBtn.disabled = false;
  }
});

// --- base map switch & collapsible sidebar -------------------------------
document.getElementById("base-dark").onclick = () => setBaseLayer("dark");
document.getElementById("base-sat").onclick = () => setBaseLayer("satellite");

const appEl = document.getElementById("app");
function setSidebar(visible) {
  appEl.classList.toggle("collapsed", !visible);
  // Leaflet must re-measure after the container resizes.
  setTimeout(() => map.invalidateSize(), 220);
}
document.getElementById("sidebar-hide").onclick = () => setSidebar(false);
document.getElementById("sidebar-show").onclick = () => setSidebar(true);

// --- export the current view as a JPG ------------------------------------
// Composites the visible tiles, the markers and a legend onto a canvas. Tiles
// are re-fetched with CORS so the canvas stays exportable.
function tileUrl(cfg, x, y, z) {
  let url = cfg.url
    .replace("{z}", z)
    .replace("{x}", x)
    .replace("{y}", y)
    .replace("{r}", "");
  if (cfg.subdomains && url.includes("{s}")) {
    const subs = cfg.subdomains;
    url = url.replace("{s}", subs[Math.abs(x + y) % subs.length]);
  }
  return url;
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // a missing tile shouldn't abort the export
    img.src = src;
  });
}

// Lays the legend out in as many columns as needed to fit the image height,
// truncating (with a "+N more" note) only if even that is not enough.
function drawLegend(ctx, entries, width, height) {
  if (entries.length === 0) return;

  const pad = 12;
  const lineH = 19;
  const colW = 200;
  const headerH = 22;
  const margin = 14;

  const maxBoxH = height - margin * 2;
  const rowsPerCol = Math.max(1, Math.floor((maxBoxH - pad * 2 - headerH) / lineH));
  const maxCols = Math.max(1, Math.min(3, Math.floor((width - margin * 2) / colW)));

  let shown = entries;
  let overflow = 0;
  const capacity = rowsPerCol * maxCols;
  if (entries.length > capacity) {
    shown = entries.slice(0, capacity - 1);
    overflow = entries.length - shown.length;
  }

  const cols = Math.min(maxCols, Math.ceil(shown.length / rowsPerCol));
  const rows = Math.min(rowsPerCol, Math.ceil(shown.length / cols));
  const boxW = pad * 2 + cols * colW;
  const boxH = pad * 2 + headerH + (rows + (overflow ? 1 : 0)) * lineH;
  const x = margin;
  const y = height - boxH - margin;

  ctx.save();
  ctx.fillStyle = "rgba(14, 17, 22, 0.84)";
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, boxW, boxH, 10);
  else ctx.rect(x, y, boxW, boxH); // older browsers
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#f0a55e";
  ctx.font = "600 14px system-ui, sans-serif";
  ctx.fillText(`Species (${entries.length})`, x + pad, y + pad + 14);

  ctx.font = "12px system-ui, sans-serif";
  shown.forEach(([name, count], i) => {
    const col = Math.floor(i / rows);
    const row = i % rows;
    const cx = x + pad + col * colW;
    const cy = y + pad + headerH + row * lineH + 10;

    const { color, shape } = styleForName(name);
    shapePath(ctx, shape, cx + 6, cy - 4, 5.5);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#e6e9ef";
    const label = name.length > 24 ? name.slice(0, 23) + "…" : name;
    ctx.fillText(`${label} (${count})`, cx + 18, cy);
  });

  if (overflow) {
    ctx.fillStyle = "#8b95a5";
    ctx.fillText(`+${overflow} more species`, x + pad, y + boxH - pad - 2);
  }
  ctx.restore();
}

async function exportMapJpg() {
  const btn = document.getElementById("save-jpg");
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Rendering…";

  try {
    const cfg = BASE_LAYERS[currentBase];
    const size = map.getSize();
    const scale = window.devicePixelRatio > 1 ? 2 : 1;

    const canvas = document.createElement("canvas");
    canvas.width = size.x * scale;
    canvas.height = size.y * scale;
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    ctx.fillStyle = cfg.background;
    ctx.fillRect(0, 0, size.x, size.y);

    // --- tiles
    const zoom = Math.round(map.getZoom());
    const tileSize = 256;
    const pixelBounds = map.getPixelBounds();
    const min = pixelBounds.min.divideBy(tileSize).floor();
    const max = pixelBounds.max.divideBy(tileSize).floor();
    const maxIndex = Math.pow(2, zoom);

    const jobs = [];
    for (let x = min.x; x <= max.x; x++) {
      for (let y = min.y; y <= max.y; y++) {
        if (y < 0 || y >= maxIndex) continue;
        const wrappedX = ((x % maxIndex) + maxIndex) % maxIndex;
        jobs.push(
          loadImage(tileUrl(cfg, wrappedX, y, zoom)).then((img) => ({
            img,
            px: x * tileSize - pixelBounds.min.x,
            py: y * tileSize - pixelBounds.min.y,
          }))
        );
      }
    }

    const tiles = await Promise.all(jobs);
    let drawn = 0;
    for (const t of tiles) {
      if (!t.img) continue;
      ctx.drawImage(t.img, t.px, t.py, tileSize, tileSize);
      drawn++;
    }
    if (drawn === 0) throw new Error("no map tiles could be loaded");

    // --- markers (only what is currently shown)
    const counts = new Map();
    for (const m of currentList) {
      const p = map.latLngToContainerPoint([m.lat, m.lng]);
      const { color, shape } = styleForName(m.name);
      shapePath(ctx, shape, p.x, p.y, 8);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#f2f5fa";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // legend entries come from the current (filtered) list
    for (const m of currentList) {
      counts.set(m.name, (counts.get(m.name) || 0) + 1);
    }
    const entries = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    drawLegend(ctx, entries, size.x, size.y);

    // --- title + attribution
    ctx.font = "600 15px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = 3;
    const title = "🍄 Mushroom Map";
    ctx.strokeText(title, 14, 26);
    ctx.fillText(title, 14, 26);

    ctx.font = "11px system-ui, sans-serif";
    const credit = cfg.credit;
    const w = ctx.measureText(credit).width;
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(size.x - w - 14, size.y - 20, w + 12, 16);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(credit, size.x - w - 8, size.y - 8);

    // --- download
    const blob = await new Promise((res) =>
      canvas.toBlob(res, "image/jpeg", 0.92)
    );
    if (!blob) throw new Error("could not encode the image");

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `mushroom-map-${new Date().toISOString().slice(0, 10)}.jpg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    btn.textContent = "✓ Saved";
  } catch (err) {
    console.error(err);
    btn.textContent = "⚠ Failed";
    alert(
      "Could not save the map image.\n\n" +
        err.message +
        "\n\nThis usually means the tile server blocked cross-origin access."
    );
  } finally {
    setTimeout(() => {
      btn.textContent = original;
      btn.disabled = false;
    }, 1800);
  }
}

document.getElementById("save-jpg").onclick = exportMapJpg;

// --- helpers -------------------------------------------------------------
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

async function refresh() {
  // Names first: they define the species -> colour mapping used by the markers.
  await loadNames();
  await loadMushrooms();
}

refresh();
