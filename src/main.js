import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import radioTemplate from '../radio-template.json';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

// ---------------------------------------------------------------------------
// Map init
// ---------------------------------------------------------------------------
const map = L.map('map', { center: [51.505, -0.09], zoom: 5, zoomControl: true });

const arcgisSatellite = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community', maxZoom: 19 }
);
const arcgisTerrain = L.tileLayer(
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Terrain_Base/MapServer/tile/{z}/{y}/{x}',
  { attribution: 'Tiles &copy; Esri &mdash; Source: USGS, Esri, TANA, DeLorme, and NPS', maxZoom: 13 }
);
arcgisSatellite.addTo(map);

L.control.layers({ 'Terrain': arcgisTerrain, 'Satellite': arcgisSatellite }, null, {
  position: 'topright', collapsed: false,
}).addTo(map);
L.control.scale({ imperial: true, metric: true, position: 'bottomleft' }).addTo(map);

// ---------------------------------------------------------------------------
// Draggable coord marker
// ---------------------------------------------------------------------------
const marker = L.marker(map.getCenter(), { draggable: true }).addTo(map);

function formatCoords(latlng) {
  const lat = Math.abs(latlng.lat).toFixed(5);
  const lng = Math.abs(latlng.lng).toFixed(5);
  return `${lat}° ${latlng.lat >= 0 ? 'N' : 'S'}  ${lng}° ${latlng.lng >= 0 ? 'E' : 'W'}`;
}

marker.bindTooltip(formatCoords(map.getCenter()), {
  permanent: true, direction: 'bottom', className: 'coord-label', offset: [0, 10],
});
marker.on('drag', (e) => marker.setTooltipContent(formatCoords(e.latlng)));
marker.on('dragend', (e) => marker.setTooltipContent(formatCoords(e.target.getLatLng())));

// ---------------------------------------------------------------------------
// Grid polygon — geo-anchored bounds, drag body + drag corners to resize
// ---------------------------------------------------------------------------
const DIVISIONS = 6;
const GRID_COLOR = '#707070';
const INNER_COUNT = (DIVISIONS - 1) * 2; // 4 vertical + 4 horizontal

// Initialise from pixel space (1/3 map width square, centred) then store as geo bounds.
// After this point all operations are in lat/lng — Leaflet renders without any zoom redraw.
let north, south, east, west;
{
  const c = map.latLngToContainerPoint(map.getCenter());
  const h = map.getSize().x / 6; // half of (mapWidth / 3)
  const nwLL = map.containerPointToLatLng(L.point(c.x - h, c.y - h));
  const seLL = map.containerPointToLatLng(L.point(c.x + h, c.y + h));
  north = nwLL.lat; south = seLL.lat; west = nwLL.lng; east = seLL.lng;
  enforceSquareCells();
}

// Cells added first → bottom of overlayPane SVG, painted behind polygon fill and grid lines
const cells = Array.from({ length: DIVISIONS * DIVISIONS }, () =>
  L.rectangle([[0, 0], [1, 1]], {
    color: 'transparent', weight: 0,
    fillColor: 'transparent', fillOpacity: 0,
    interactive: false,
  }).addTo(map)
);

const gridPolygon = L.polygon([], {
  color: GRID_COLOR, weight: 2, opacity: 0.9,
  fillColor: GRID_COLOR, fillOpacity: 0.07,
  className: 'grid-draggable', interactive: true,
}).addTo(map);

const innerLines = Array.from({ length: INNER_COUNT }, () =>
  L.polyline([], { color: GRID_COLOR, weight: 0.8, opacity: 0.45, interactive: false }).addTo(map)
);

const areaLabel = L.marker(map.getCenter(), {
  icon: L.divIcon({ html: '', className: '', iconSize: [0, 0], iconAnchor: [0, 0] }),
  interactive: false, zIndexOffset: 1000,
}).addTo(map);

// Corner definitions: position getter + which corner is opposite (fixed during resize)
const CORNER_DEFS = [
  { id: 'nw', pos: () => L.latLng(north, west), oppId: 'se' },
  { id: 'ne', pos: () => L.latLng(north, east), oppId: 'sw' },
  { id: 'se', pos: () => L.latLng(south, east), oppId: 'nw' },
  { id: 'sw', pos: () => L.latLng(south, west), oppId: 'ne' },
];

// --- helpers ---

function haversineKm(a, b) {
  const R = 6371;
  const toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function computeArea() {
  const midLat = (north + south) / 2;
  const midLng = (west + east) / 2;
  return haversineKm(L.latLng(midLat, west), L.latLng(midLat, east)) *
         haversineKm(L.latLng(south, midLng), L.latLng(north, midLng));
}

function fmtArea(km2) {
  if (km2 >= 1e6) return `${(km2 / 1e6).toFixed(2)} M km²`;
  if (km2 >= 1e3) return `${(km2 / 1e3).toFixed(1)} k km²`;
  if (km2 < 0.01) return `${(km2 * 1e6).toFixed(0)} m²`;
  return `${km2.toFixed(2)} km²`;
}

// Resolution in metres scaled by grid area: 5 m at ≤2 km², 30 m at ≥10 km².
function computeRes() {
  const area = computeArea();
  if (area <= 2)  return 10;
  if (area >= 30) return 30;
  return Math.round(area);
}

// Adjust east/west so each cell's km width equals its km height (square cells).
// Keeps the lat span and centre fixed; corrects for lng compression at latitude.
function enforceSquareCells() {
  const midLat = (north + south) / 2;
  const midLng = (west + east) / 2;
  const halfLng = (north - south) / (2 * Math.cos(midLat * Math.PI / 180));
  west = midLng - halfLng;
  east = midLng + halfLng;
}

// declared before redrawGrid so optional chains inside work on first call
let cornerHandles;

function redrawGrid() {
  gridPolygon.setLatLngs([
    L.latLng(north, west), L.latLng(north, east),
    L.latLng(south, east), L.latLng(south, west),
  ]);

  // Inner lines divided evenly in lat/lng space — geo-correct at all zoom levels
  let idx = 0;
  for (let i = 1; i < DIVISIONS; i++) {
    const lngOff = west + (east - west) * i / DIVISIONS;
    const latOff = south + (north - south) * i / DIVISIONS;
    innerLines[idx++].setLatLngs([L.latLng(north, lngOff), L.latLng(south, lngOff)]);
    innerLines[idx++].setLatLngs([L.latLng(latOff, west), L.latLng(latOff, east)]);
  }

  cornerHandles?.forEach((h, i) => h.setLatLng(CORNER_DEFS[i].pos()));

  const midLat = (north + south) / 2;
  const midLng = (west + east) / 2;
  areaLabel.setLatLng(L.latLng(midLat, midLng));
  areaLabel.setIcon(L.divIcon({
    html: `<div class="grid-label">${fmtArea(computeArea())}</div>`,
    className: '', iconSize: [0, 0], iconAnchor: [0, 0],
  }));

  const resEl = document.getElementById('res-display');
  if (resEl) resEl.textContent = `${computeRes()} m`;

  // Reposition cell rectangles and labels to match current grid bounds
  cells?.forEach((cell, i) => {
    const r = Math.floor(i / DIVISIONS);
    const c = i % DIVISIONS;
    cell.setBounds([
      [south + (north - south) * r       / DIVISIONS, west + (east - west) * c       / DIVISIONS],
      [south + (north - south) * (r + 1) / DIVISIONS, west + (east - west) * (c + 1) / DIVISIONS],
    ]);
  });


}

// --- corner handle circles (pixel-radius, geo-anchored position) ---
cornerHandles = CORNER_DEFS.map(({ id, pos }) =>
  L.circleMarker(pos(), {
    radius: 6, color: '#ffffff', weight: 2,
    fillColor: GRID_COLOR, fillOpacity: 1,
    interactive: true, className: `corner-handle corner-${id}`,
  }).addTo(map)
);

redrawGrid();

// ---------------------------------------------------------------------------
// Interaction — shared mousemove/mouseup on the map for both body and corner
// ---------------------------------------------------------------------------
let isDragging = false;
let activeResize = null; // { anchorLL, signX, signY }
let dragStartMouse = null;
let dragStartCenterLL = null;
let dragStartBounds = null;
let dragMoved = false;
let cellsAnalysed = false;
let cellStddevs = [];

// Body drag
gridPolygon.on('mousedown', (e) => {
  isDragging = true;
  dragMoved = false;
  dragStartMouse = e.containerPoint;
  dragStartCenterLL = L.latLng((north + south) / 2, (west + east) / 2);
  dragStartBounds = { north, south, east, west };
  map.dragging.disable();
  L.DomEvent.stop(e);
});

// Corner resize — lock the sign at dragstart so the polygon can't flip
cornerHandles.forEach((handle, i) => {
  const def = CORNER_DEFS[i];
  handle.on('mousedown', (e) => {
    const oppDef = CORNER_DEFS.find(d => d.id === def.oppId);
    const anchorLL = oppDef.pos();
    const anchorPx = map.latLngToContainerPoint(anchorLL);
    const handlePx = map.latLngToContainerPoint(def.pos());
    activeResize = {
      anchorLL,
      signX: Math.sign(handlePx.x - anchorPx.x) || 1,
      signY: Math.sign(handlePx.y - anchorPx.y) || 1,
    };
    map.dragging.disable();
    L.DomEvent.stop(e);
  });
});

map.on('mousemove', (e) => {
  if (isDragging) {
    dragMoved = true;
    const startPx = map.latLngToContainerPoint(dragStartCenterLL);
    const dx = e.containerPoint.x - dragStartMouse.x;
    const dy = e.containerPoint.y - dragStartMouse.y;
    const newCenterLL = map.containerPointToLatLng(L.point(startPx.x + dx, startPx.y + dy));
    const dLat = newCenterLL.lat - dragStartCenterLL.lat;
    const dLng = newCenterLL.lng - dragStartCenterLL.lng;
    north = dragStartBounds.north + dLat;
    south = dragStartBounds.south + dLat;
    east  = dragStartBounds.east  + dLng;
    west  = dragStartBounds.west  + dLng;
    redrawGrid();
  } else if (activeResize) {
    const { anchorLL, signX, signY } = activeResize;
    const mapW  = map.getSize().x;
    const minPx = mapW * 0.02;
    const maxPx = mapW * 0.9;
    const anchorPx = map.latLngToContainerPoint(anchorLL);
    const dx = e.containerPoint.x - anchorPx.x;
    const dy = e.containerPoint.y - anchorPx.y;
    const cx = anchorPx.x + Math.max(minPx, Math.min(maxPx, Math.abs(dx))) * signX;
    const cy = anchorPx.y + Math.max(minPx, Math.min(maxPx, Math.abs(dy))) * signY;
    const newLL = map.containerPointToLatLng(L.point(cx, cy));
    north = Math.max(anchorLL.lat, newLL.lat);
    south = Math.min(anchorLL.lat, newLL.lat);
    east  = Math.max(anchorLL.lng, newLL.lng);
    west  = Math.min(anchorLL.lng, newLL.lng);
    redrawGrid();
  }
});

map.on('mouseup mouseleave', () => {
  const wasResize = !!activeResize;
  if (isDragging || activeResize) {
    isDragging = false;
    activeResize = null;
    map.dragging.enable();
  }
  if (wasResize) { enforceSquareCells(); redrawGrid(); runCloudrfCells(); }
});

// Cell hover tooltip — shows stddev error for the cell under the cursor
gridPolygon.bindTooltip('', { sticky: true, className: 'cell-hover-tip', offset: [12, 0] });

gridPolygon.on('mousemove', (e) => {
  if (!cellStddevs.length) return;
  const col = Math.floor((e.latlng.lng - west) / (east - west) * DIVISIONS);
  const row = Math.floor((e.latlng.lat - south) / (north - south) * DIVISIONS);
  if (col < 0 || col >= DIVISIONS || row < 0 || row >= DIVISIONS) return;
  const val = cellStddevs[row * DIVISIONS + col];
  gridPolygon.setTooltipContent(val != null ? `${val.toFixed(1)} dB` : '—');
});

gridPolygon.on('mouseout', () => gridPolygon.closeTooltip());

// Cell click — zoom grid into clicked cell (only active after CloudRF analysis)
gridPolygon.on('click', (e) => {
  if (!cellsAnalysed || dragMoved) return;

  const { lat, lng } = e.latlng;
  const col = Math.floor((lng - west) / (east - west) * DIVISIONS);
  const row = Math.floor((lat - south) / (north - south) * DIVISIONS);
  if (col < 0 || col >= DIVISIONS || row < 0 || row >= DIVISIONS) return;

  const cellW = (east - west)  / DIVISIONS;
  const cellH = (north - south) / DIVISIONS;
  const pad   = cellH * 0.25; // 0.25 each side → total height = 1.5× cell

  const cellS = south + cellH * row;
  const cellN = cellS + cellH;
  const cellWst = west + cellW * col;
  const cellEst = cellWst + cellW;

  north = cellN   + pad;
  south = cellS   - pad;
  east  = cellEst + pad;
  west  = cellWst - pad;
  enforceSquareCells();

  cells.forEach(cell => cell.setStyle({ fillColor: 'transparent', fillOpacity: 0 }));
  cellsAnalysed = false;
  document.getElementById('cell-legend-lo').textContent  = '—';
  document.getElementById('cell-legend-mid').textContent = '—';
  document.getElementById('cell-legend-hi').textContent  = '—';
  redrawGrid();
  runCloudrfCells();
});

// ---------------------------------------------------------------------------
// CSV import — Latitude, Longitude, RSSI
// ---------------------------------------------------------------------------

// -30 dBm → hue 0 (red), -100 dBm → hue 240 (blue), rainbow between
function rssiToColor(rssi) {
  const hue = Math.min(240, Math.max(0, ((rssi + 30) / -70) * 240));
  return `hsl(${hue}, 100%, 50%)`;
}

// Fire palette for stddev of (measured − predicted) dB differences.
// minS → white (best agreement), maxS → black (worst agreement).
function stddevToFireColor(stddev, minS, maxS) {
  const range = maxS - minS;
  const t = range === 0 ? 1 : Math.max(0, Math.min(1, 1 - (stddev - minS) / range));
  const stops = [
    [0.00, [0,   0,   0  ]],  // black
    [0.25, [160, 0,   0  ]],  // dark red
    [0.50, [255, 90,  0  ]],  // orange
    [0.75, [255, 210, 0  ]],  // amber
    [1.00, [255, 255, 255]],  // white
  ];
  for (let i = 1; i < stops.length; i++) {
    const [t0, c0] = stops[i - 1];
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const f = (t - t0) / (t1 - t0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * f);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * f);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * f);
      return `rgb(${r},${g},${b})`;
    }
  }
  return '#ffffff';
}

const csvGroup = L.layerGroup().addTo(map);
let keptPoints = []; // { lat, lng, rssi, color, dot } — kept after decimation
let totalApiCalls  = 0;
let totalPaths     = 0;
let totalApiMs     = 0;

// Custom Leaflet control — import / CloudRF / settings + legend
const csvControl = L.control({ position: 'bottomright' });
csvControl.onAdd = function () {
  const div = L.DomUtil.create('div', 'csv-control');
  div.innerHTML = `
    <div class="csv-buttons">
      <label class="csv-btn" title="CSV columns: Latitude,Longitude,RSSI">
        ↑ Import CSV
        <input type="file" id="csv-file-input" accept=".csv,.txt">
      </label>
      <button class="csv-clear-btn" id="csv-clear" title="Clear imported points">✕</button>
      <button class="csv-clear-btn" id="open-settings" title="CloudRF settings">⚙</button>
    </div>
    <div class="legend-title">RSSI</div>
    <div class="rssi-legend-bar"></div>
    <div class="rssi-legend-labels">
      <span>−30 dBm</span><span>−65</span><span>−100</span>
    </div>
    <div class="legend-title" style="margin-top:6px">Cell Δ σ</div>
    <div class="cell-legend-bar"></div>
    <div class="rssi-legend-labels">
      <span id="cell-legend-lo">—</span><span id="cell-legend-mid">—</span><span id="cell-legend-hi">—</span>
    </div>
    <div class="legend-title" style="margin-top:6px">Resolution</div>
    <div id="res-display" style="font-size:11px;text-align:center;color:#ccc;padding:2px 0">— m</div>
    <div class="legend-title" style="margin-top:6px">API Usage</div>
    <div id="api-stats" style="font-size:11px;text-align:center;color:#ccc;padding:2px 0">0 calls · 0 paths</div>
    <div id="api-avg-time" style="font-size:11px;text-align:center;color:#ccc;padding:2px 0">avg — ms / call</div>
  `;
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  return div;
};
csvControl.addTo(map);


function parseAndPlot(text) {
  // Clear any previously imported points before plotting new ones
  csvGroup.clearLayers();
  keptPoints = [];
  cells.forEach(cell => cell.setStyle({ fillColor: 'transparent', fillOpacity: 0 }));
  cellsAnalysed = false;
  cellStddevs = [];

  // 1. Parse all valid rows
  const points = [];
  for (const row of text.trim().split(/\r?\n/)) {
    const cols = row.split(',').map(s => s.trim());
    if (cols.length < 3) continue;
    const lat  = parseFloat(cols[0]);
    const lng  = parseFloat(cols[1]);
    const rssi = parseFloat(cols[2]);
    if (isNaN(lat) || isNaN(lng) || isNaN(rssi)) continue; // skip header / bad rows
    points.push({ lat, lng, rssi });
  }

  // 2. Decimate across full dataset, then cap at 100
  const kept = [];
  for (const p of points) {
    if (!kept.some(k => haversineKm(k, p) * 1000 < 300)) kept.push(p);
  }
  kept.splice(100);

  // 3. Plot and store references for the CloudRF run
  keptPoints = [];
  kept.forEach(({ lat, lng, rssi }) => {
    const color = rssiToColor(rssi);
    const dot = L.circleMarker([lat, lng], {
      radius: 7,
      fillColor: color,
      color: 'rgba(0,0,0,0.55)',
      weight: 1,
      fillOpacity: 1,
    });
    dot.bindTooltip(
      `<span style="color:${color}">${rssi}</span>`,
      { permanent: true, direction: 'top', className: 'rssi-label', offset: [0, -9] }
    );
    csvGroup.addLayer(dot);
    keptPoints.push({ lat, lng, rssi, color, dot });
  });

  if (kept.length) {
    // Fit the grid to the top 50% strongest RSSI readings only (higher = stronger)
    const sorted = [...kept].sort((a, b) => b.rssi - a.rssi);
    const fitPts = sorted.slice(0, Math.ceil(sorted.length * 0.3));
    north = Math.max(...fitPts.map(p => p.lat));
    south = Math.min(...fitPts.map(p => p.lat));
    east  = Math.max(...fitPts.map(p => p.lng));
    west  = Math.min(...fitPts.map(p => p.lng));
    enforceSquareCells();
    redrawGrid();
    map.flyTo([(north + south) / 2, (west + east) / 2], 12);
    document.getElementById('cloudrf-run').disabled = false;
  }
}

document.getElementById('csv-file-input').addEventListener('change', function (e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => parseAndPlot(ev.target.result);
  reader.readAsText(file);
  this.value = ''; // allow re-importing the same file
});

document.getElementById('csv-clear').addEventListener('click', () => {
  csvGroup.clearLayers();
  keptPoints = [];
  cells.forEach(cell => cell.setStyle({ fillColor: 'transparent', fillOpacity: 0 }));
  cellsAnalysed = false;
  cellStddevs = [];
  document.getElementById('cloudrf-run').disabled = true;
});

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------
const STORAGE_SERVER = 'cloudrf_server';
const STORAGE_KEY    = 'cloudrf_key';

function openSettings() {
  document.getElementById('settings-server').value =
    localStorage.getItem(STORAGE_SERVER) || 'https://api.cloudrf.com';
  document.getElementById('settings-key').value =
    localStorage.getItem(STORAGE_KEY) || '';
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

function saveSettings() {
  localStorage.setItem(STORAGE_SERVER,
    document.getElementById('settings-server').value.trim() || 'https://api.cloudrf.com');
  localStorage.setItem(STORAGE_KEY,
    document.getElementById('settings-key').value.trim());
  closeSettings();
}

document.getElementById('open-settings').addEventListener('click', openSettings);
document.getElementById('settings-close').addEventListener('click', closeSettings);
document.getElementById('settings-cancel').addEventListener('click', closeSettings);
document.getElementById('settings-save').addEventListener('click', saveSettings);
document.getElementById('settings-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) closeSettings(); // click outside dialog
});

// ---------------------------------------------------------------------------
// CloudRF POINTS — one request per grid cell, CSV markers as transmitters
// ---------------------------------------------------------------------------
async function runCloudrfCells() {
  const server = localStorage.getItem(STORAGE_SERVER) || 'https://api.cloudrf.com';
  const apiKey = localStorage.getItem(STORAGE_KEY) || '';

  if (!apiKey) { openSettings(); return; }
  if (!keptPoints.length) return;

  const btn = document.getElementById('cloudrf-run');
  btn.disabled = true;

  const txAlt  = radioTemplate.transmitter?.alt ?? 2;
  const txPts  = keptPoints.map(p => ({ lat: p.lat, lon: p.lng, alt: txAlt }));
  const total  = DIVISIONS * DIVISIONS;

  // Reset cell fills + labels and show spinner in the area-label slot
  cells.forEach(cell => cell.setStyle({ fillColor: 'transparent', fillOpacity: 0 }));
  areaLabel.setIcon(L.divIcon({
    html: '<div class="cell-spinner"></div>',
    className: '', iconSize: [0, 0], iconAnchor: [0, 0],
  }));

  // Phase 1 — stagger requests 100 ms apart; responses can arrive in any order.
  // Each closure captures its own cell index i so results are always written to the right slot.
  const stddevs = new Array(total).fill(null);
  const cellRes = computeRes();
  let completed = 0;

  btn.title = `CloudRF — 0 of ${total} complete`;

  await Promise.all(Array.from({ length: total }, (_, i) => new Promise(resolve => {
    const r    = Math.floor(i / DIVISIONS);
    const c    = i % DIVISIONS;
    const cS   = south + (north - south) * r       / DIVISIONS;
    const cN   = south + (north - south) * (r + 1) / DIVISIONS;
    const cW   = west  + (east  - west)  * c       / DIVISIONS;
    const cE   = west  + (east  - west)  * (c + 1) / DIVISIONS;
    const body = {
      ...radioTemplate,
      transmitter: { ...radioTemplate.transmitter },
      output:      { ...radioTemplate.output, res: cellRes },
      points:      txPts,
      receiver:    { ...radioTemplate.receiver, lat: (cS + cN) / 2, lon: (cW + cE) / 2 },
    };

    setTimeout(async () => {
      // darken this cell when its request fires, not all at once up front
      cells[i].setStyle({ fillColor: '#1c1c1c', fillOpacity: 0.75, color: 'transparent', weight: 0 });
      try {
        const t0   = performance.now();
        const resp = await fetch(`${server}/points`, {
          method: 'POST',
          headers: { 'key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        totalApiMs += performance.now() - t0;

        const txResults = data?.Transmitters ?? [];
        totalApiCalls++;
        totalPaths += txResults.length;
        completed++;

        const avgMs = Math.round(totalApiMs / totalApiCalls);
        btn.title = `CloudRF — ${completed} of ${total} complete`;
        document.getElementById('api-stats').textContent =
          `${totalApiCalls} call${totalApiCalls !== 1 ? 's' : ''} · ${totalPaths} path${totalPaths !== 1 ? 's' : ''}`;
        document.getElementById('api-avg-time').textContent =
          `avg ${avgMs < 1000 ? `${avgMs} ms` : `${(avgMs / 1000).toFixed(1)} s`} / call`;

        const diffs = keptPoints
          .map((p, j) => {
            const pred = txResults[j]?.['Signal power at receiver dBm'];
            return pred != null ? p.rssi - pred : null;
          })
          .filter(d => d !== null);

        if (diffs.length > 0) {
          const mean     = diffs.reduce((s, d) => s + d, 0) / diffs.length;
          const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length;
          stddevs[i] = Math.sqrt(variance);
          // colour immediately using the provisional fixed scale; Phase 2 recolours with the true scale
          cells[i].setStyle({ fillColor: stddevToFireColor(stddevs[i], 5, 15), fillOpacity: 0.82, color: 'transparent', weight: 0 });
        }
      } catch (err) {
        console.error(`CloudRF cell ${i} error:`, err);
      }
      resolve();
    }, i * 80);
  })));

  // Phase 2 — colour scale: fixed 5–15 dB if any cell exceeds 15 dB, otherwise 5–actualMax
  const validStddevs = stddevs.filter(v => v !== null);
  const actualMax = validStddevs.length ? Math.max(...validStddevs) : 15;
  const minS = 5;
  const maxS = actualMax > 15 ? 15 : actualMax;

  document.getElementById('cell-legend-lo').textContent  = '5 dB';
  document.getElementById('cell-legend-mid').textContent = ((minS + maxS) / 2).toFixed(1);
  document.getElementById('cell-legend-hi').textContent  = `${maxS.toFixed(1)} dB`;

  stddevs.forEach((stddev, i) => {
    if (stddev !== null) {
      cells[i].setStyle({
        fillColor: stddevToFireColor(stddev, minS, maxS),
        fillOpacity: 0.82,
        color: 'transparent',
        weight: 0,
      });
    } else {
      cells[i].setStyle({ fillColor: '#444', fillOpacity: 0.4 });
    }
  });

  cellStddevs = stddevs.slice();
  cellsAnalysed = true;
  redrawGrid(); // restores the km² area label
  btn.title = 'Run CloudRF POINTS analysis';
  btn.disabled = false;
}

document.getElementById('cloudrf-run').addEventListener('click', runCloudrfCells);
