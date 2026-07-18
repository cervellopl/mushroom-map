// --- map setup (dark theme via CartoDB dark_matter tiles) ----------------
const map = L.map("map", { zoomControl: true }).setView([50.06, 19.94], 6);

L.tileLayer(
  "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    subdomains: "abcd",
    maxZoom: 20,
  }
).addTo(map);

const markerLayer = L.layerGroup().addTo(map);
const markersById = new Map();

// --- per-species colour ---------------------------------------------------
// A curated palette that reads well on dark tiles. Colours are handed out by
// each species' position in the sorted list of known names, so two different
// species never share a colour (until the palette wraps at 14).
const PALETTE = [
  "#e6584f", "#f0883e", "#f2c744", "#9fd356", "#4fc46a", "#35c9a5", "#3fbdd8",
  "#4f8ff0", "#7c6ff0", "#a86ce0", "#e06cc4", "#f07396", "#b58a5a", "#8fa3b8",
];

let colorByName = new Map();

function assignColors(names) {
  colorByName = new Map();
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  const n = sorted.length;

  sorted.forEach((name, i) => {
    // With room to spare, spread picks across the palette so neighbouring
    // species get well-separated hues instead of adjacent ones.
    const idx =
      n <= PALETTE.length
        ? Math.floor((i * PALETTE.length) / Math.max(n, 1))
        : i % PALETTE.length;
    colorByName.set(name.trim().toLowerCase(), PALETTE[idx]);
  });
}

function colorForName(name) {
  const key = String(name).trim().toLowerCase();
  const known = colorByName.get(key);
  if (known) return known;

  // Fallback for a name not yet in /api/names (stable hash into the palette).
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return PALETTE[(h >>> 0) % PALETTE.length];
}

function markerStyle(name) {
  return {
    radius: 8,
    fillColor: colorForName(name),
    fillOpacity: 0.95,
    color: "#f2f5fa",
    weight: 1.5,
    opacity: 0.9,
  };
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
  assignColors(names);
  nameOptions.innerHTML = names
    .map((n) => `<option value="${escapeHtml(n)}"></option>`)
    .join("");
}

async function loadMushrooms() {
  const q = filterInput.value.trim();
  const url = q ? `/api/mushrooms?name=${encodeURIComponent(q)}` : "/api/mushrooms";
  const res = await fetch(url);
  const list = await res.json();

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
    const marker = L.circleMarker([m.lat, m.lng], markerStyle(m.name));
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
      <h3><span class="dot" style="background:${colorForName(m.name)}"></span>${escapeHtml(m.name)}</h3>
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
          <span class="dot" style="background:${colorForName(name)}"></span>
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
              <span class="dot" style="background:${colorForName(m.name)}"></span>
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
