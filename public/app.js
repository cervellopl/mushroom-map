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

// mushroom-cap colored marker
function mushroomIcon() {
  return L.divIcon({
    className: "",
    html: '<div style="font-size:26px;line-height:26px;filter:drop-shadow(0 1px 2px #000)">🍄</div>',
    iconSize: [26, 26],
    iconAnchor: [13, 24],
    popupAnchor: [0, -22],
  });
}

const markerLayer = L.layerGroup().addTo(map);

// --- elements ------------------------------------------------------------
const filterInput = document.getElementById("filter-name");
const clearFilterBtn = document.getElementById("clear-filter");
const nameOptions = document.getElementById("name-options");
const countEl = document.getElementById("count");
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
  else pinMarker = L.marker(latlng, { icon: mushroomIcon(), opacity: 0.6 }).addTo(map);
  map.setView(latlng, Math.max(map.getZoom(), 13));
}

// --- data loading --------------------------------------------------------
async function loadNames() {
  const res = await fetch("/api/names");
  const names = await res.json();
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
  countEl.textContent =
    `${list.length} sighting${list.length === 1 ? "" : "s"}` +
    (q ? ` matching “${q}”` : "");
}

function renderMarkers(list) {
  markerLayer.clearLayers();
  const bounds = [];
  for (const m of list) {
    const marker = L.marker([m.lat, m.lng], { icon: mushroomIcon() });
    marker.bindPopup(popupHtml(m));
    marker.on("popupopen", (e) => {
      const btn = e.popup.getElement().querySelector(".del");
      if (btn) btn.onclick = () => deleteMushroom(m.id);
    });
    marker.addTo(markerLayer);
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
      <h3>${escapeHtml(m.name)}</h3>
      ${img}
      ${notes}
      <div class="meta">${m.lat.toFixed(5)}, ${m.lng.toFixed(5)}</div>
      <div class="meta">${when}</div>
      <button class="del">Delete</button>
    </div>`;
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

// --- filter --------------------------------------------------------------
let debounce;
filterInput.addEventListener("input", () => {
  clearTimeout(debounce);
  debounce = setTimeout(loadMushrooms, 250);
});
clearFilterBtn.addEventListener("click", () => {
  filterInput.value = "";
  loadMushrooms();
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
  await Promise.all([loadNames(), loadMushrooms()]);
}

refresh();
