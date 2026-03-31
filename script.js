const MAX_HISTORY = 10;
const MAX_POINTS = 520000;    // 30 days of data in memory
const CHART_RESOLUTION = 600; // max points drawn on screen
let allPoints = [];
let lastLineCount = 0;
let selectedHours = 24;

// ── House Energy Classification Thresholds ──────────────────────────────────
// Adjust these based on your household. PIR Raw Std is the standard deviation
// of the analog PIR sensor readings within a 1-hour window.
// Derived from 16 days of data: quiet windows have std ~9–15, active ~40–300+.
const WIFI_HOME_THRESHOLD = 14;       // devices — above this means "people are home"
const PIR_ACTIVE_THRESHOLD = 40;      // PIR raw std — above this means "active in living room"
const PIR_QUIET_THRESHOLD = 15;       // PIR raw std — below this means "nobody moving at all"
const ENERGY_CHUNK_SECONDS = 3600;    // 1 hour per chunk

// Colors for each house energy state
const ENERGY_COLORS = {
  connected: '#FF6B9D',               // warm pink — everyone home, together
  isolated:  '#8B5CF6',               // muted purple — people home, in own rooms
  empty:     'rgba(115, 0, 58, 0.3)'  // dim — nobody home or asleep
};

const ENERGY_LABELS = {
  connected: 'Connected',
  isolated:  'Isolated',
  empty:     'Empty'
};

// Every data series lives here. Each can be toggled on/off independently.
// `axis` determines which Y-axis it scales to (left or right).
// Series on the same axis share a Y range so their values are comparable.
// `stepped` draws discrete jumps instead of smooth lines (for integer counts).
// `filter` excludes invalid points before downsampling (e.g. wifi = -1).
const seriesConfig = {
  mag:  { label: '|B| Magnitude', color: '#F3B3FF', unit: 'µT',      axis: 'left',  getValue: p => p.mag.mag },
  x:    { label: 'X',             color: '#FF6B9D', unit: 'µT',      axis: 'left',  getValue: p => p.mag.x },
  y:    { label: 'Y',             color: '#C084FC', unit: 'µT',      axis: 'left',  getValue: p => p.mag.y },
  z:    { label: 'Z',             color: '#67E8F9', unit: 'µT',      axis: 'left',  getValue: p => p.mag.z },
  pir:  { label: 'PIR Raw',       color: '#FFD700', unit: '',         axis: 'right', getValue: p => p.pir.raw },
  wifi: { label: 'WiFi Devices',  color: '#4ADE80', unit: 'devices',  axis: 'right', getValue: p => p.wifi_devices,
          stepped: true, filter: p => p.wifi_devices != null && p.wifi_devices >= 0 }
};

let activeSeries = new Set(['mag']); // Checkbox-style — any combination can be active
let seriesData = {};                  // key → downsampled points array
let filteredTMin = 0;                 // Full filtered time range — stable across toggles
let filteredTMax = 0;

function setup() {
  setInterval(fetchText, 5000);
  fetchText();
  setupChart();
  setupEnergyTooltip();
}

function fetchText() {
  fetch('log.json', {
    cache: 'no-cache',
    headers: { 'accept': 'application/json' }
  })
    .then(response => response.text())
    .then(data => processData(data))
    .catch(error => console.error('Fetch error:', error));
}

function processData(data) {
  const lines = data.trim().split('\n').filter(line => line.trim());
  const newLines = lines.slice(lastLineCount);

  if (newLines.length > 0) {
    for (const line of newLines) {
      try {
        const parsed = JSON.parse(line.trim());
        if (parsed.mag && parsed.pir) {
          // Backwards-compatible: old log entries without network fields still load fine
          if (parsed.wifi_devices === undefined) parsed.wifi_devices = -1;
          if (parsed.network === undefined) parsed.network = "Unknown";
          allPoints.push(parsed);
        }
      } catch (e) {}
    }

    if (allPoints.length > MAX_POINTS) {
      allPoints = allPoints.slice(-MAX_POINTS);
    }

    lastLineCount = lines.length;
    updateLiveReading();
    updateHistory();
    drawChart();
    drawMotionStrip();
    drawEnergyStrip();
  }
}

function updateLiveReading() {
  if (allPoints.length === 0) return;
  const latest = allPoints[allPoints.length - 1];

  document.getElementById('val-x').textContent = latest.mag.x.toFixed(1);
  document.getElementById('val-y').textContent = latest.mag.y.toFixed(1);
  document.getElementById('val-z').textContent = latest.mag.z.toFixed(1);
  document.getElementById('magnitude').textContent = `|B| = ${latest.mag.mag.toFixed(1)} µT`;

  updateBar(document.getElementById('bar-x'), latest.mag.x);
  updateBar(document.getElementById('bar-y'), latest.mag.y);
  updateBar(document.getElementById('bar-z'), latest.mag.z);

  document.getElementById('pir-raw').textContent = latest.pir.raw;
  const motionEl = document.getElementById('pir-motion');
  motionEl.textContent = latest.pir.motion ? 'Motion' : 'Clear';
  motionEl.className = 'pir-status ' + (latest.pir.motion ? 'motion-yes' : 'motion-no');

  // Last motion timestamp
  const lastMotionEl = document.getElementById('last-motion');
  if (lastMotionEl) {
    let lastMotionPoint = null;
    for (let i = allPoints.length - 1; i >= 0; i--) {
      if (allPoints[i].pir.motion) { lastMotionPoint = allPoints[i]; break; }
    }
    lastMotionEl.textContent = lastMotionPoint ? formatTimestamp(lastMotionPoint.ts) : 'None';
    lastMotionEl.style.color = lastMotionPoint && latest.pir.motion ? '#ffb3c6' : '#CED1B6';
  }

  // Network info — show which WiFi and how many devices
  const networkLabel = document.getElementById('network-label');
  if (networkLabel) {
    networkLabel.textContent = latest.network || '—';
    networkLabel.className = 'network-label ' + (latest.network === 'Home' ? 'network-home' : 'network-sandbox');
  }
  const wifiDevices = document.getElementById('wifi-devices');
  if (wifiDevices) {
    wifiDevices.textContent = (latest.wifi_devices >= 0) ? latest.wifi_devices : '—';
  }
}

function updateBar(el, value, maxRange = 1300) {
  const pct = Math.min(Math.abs(value) / maxRange * 50, 50);
  if (value >= 0) {
    el.style.left  = '50%';
    el.style.right = 'auto';
  } else {
    el.style.right = '50%';
    el.style.left  = 'auto';
  }
  el.style.width = pct + '%';
}

function updateHistory() {
  const container = document.getElementById('raw-data');
  if (!container) return;

  container.innerHTML = '';
  const recentPoints = allPoints.slice(-MAX_HISTORY).reverse();

  recentPoints.forEach((point, index) => {
    const entry = document.createElement('div');
    entry.className = 'data-entry' + (index > 0 ? ' old' : '');
    // All values come from our own sensor JSON — no user-editable input
    entry.innerHTML = `
      <div class="timestamp">${formatTimestamp(point.ts)}</div>
      <div class="values">
        <span>X: ${point.mag.x.toFixed(1)} µT</span>
        <span>Y: ${point.mag.y.toFixed(1)} µT</span>
        <span>Z: ${point.mag.z.toFixed(1)} µT</span>
        <span>|B|: ${point.mag.mag.toFixed(1)} µT</span>
        <span class="${point.pir.motion ? 'motion-yes' : 'motion-no'}">PIR: ${point.pir.motion ? 'motion' : 'clear'} (${point.pir.raw})</span>
        <span style="color:#4ADE80">${point.network}${point.wifi_devices >= 0 ? ' · ' + point.wifi_devices + ' devices' : ''}</span>
      </div>
    `;
    container.appendChild(entry);
  });
}

function formatTimestamp(ts) {
  if (ts > 1000000000) {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
           + ' ' + d.toLocaleTimeString();
  }
  return `t+${(ts / 1000).toFixed(0)}s`;
}

// ── House Energy Classification ──────────────────────────────────────────────

// Grouping points into 1-hour time buckets and classifying each bucket into
// one of three states: "connected", "isolated", or "empty".
// The classification uses WiFi device count + PIR Raw standard deviation.
// Z axis std is computed for display but doesn't drive the classification —
// it doesn't vary with human activity based on 16 days of observed data.
function classifyChunks(points) {
  if (points.length === 0) return [];

  const chunks = [];
  const chunkSize = ENERGY_CHUNK_SECONDS;

  // Finding the time boundaries — aligning to whole hours for clean chunks
  const firstTs = points[0].ts;
  const lastTs = points[points.length - 1].ts;
  const startHour = Math.floor(firstTs / chunkSize) * chunkSize;

  for (let ts = startHour; ts < lastTs; ts += chunkSize) {
    const tsEnd = ts + chunkSize;

    // Gathering all points that fall in this hour
    const bucket = points.filter(p => p.ts >= ts && p.ts < tsEnd);
    if (bucket.length < 10) continue; // Not enough data to classify

    // Computing PIR Raw standard deviation — the main activity signal
    const pirRaws = bucket.map(p => p.pir.raw);
    const pirMean = pirRaws.reduce((a, b) => a + b, 0) / pirRaws.length;
    const pirRawStd = Math.sqrt(pirRaws.reduce((sum, v) => sum + (v - pirMean) ** 2, 0) / pirRaws.length);

    // Computing Z axis stats for display texture
    const zVals = bucket.map(p => p.mag.z);
    const zMean = zVals.reduce((a, b) => a + b, 0) / zVals.length;
    const zStd = Math.sqrt(zVals.reduce((sum, v) => sum + (v - zMean) ** 2, 0) / zVals.length);

    // Computing WiFi device average — only from valid readings
    const wifiVals = bucket.filter(p => p.wifi_devices >= 0).map(p => p.wifi_devices);
    const wifiAvg = wifiVals.length > 0 ? wifiVals.reduce((a, b) => a + b, 0) / wifiVals.length : -1;

    // Classifying: WiFi tells us "are people home?", PIR Raw Std tells us "are they in this room?"
    let state;
    if (pirRawStd > PIR_ACTIVE_THRESHOLD) {
      // Active presence in the room — someone's definitely here
      state = 'connected';
    } else if (wifiAvg >= WIFI_HOME_THRESHOLD || wifiAvg < 0) {
      // Devices suggest people are home (or no wifi data), but room is quiet
      if (pirRawStd <= PIR_QUIET_THRESHOLD && wifiAvg >= 0 && wifiAvg < WIFI_HOME_THRESHOLD) {
        state = 'empty';
      } else {
        state = 'isolated';
      }
    } else {
      // Few devices and quiet room
      state = 'empty';
    }

    chunks.push({ tsStart: ts, tsEnd, state, wifiAvg, pirRawStd, zStd, zMean });
  }

  return chunks;
}

// ── Chart ────────────────────────────────────────────────────────────────────

function getFilteredPoints() {
  if (allPoints.length === 0) return [];
  const latest = allPoints[allPoints.length - 1];
  const cutoff = latest.ts - (selectedHours * 3600);
  return allPoints.filter(p => p.ts >= cutoff);
}

// Downsample using min/max bucketing to preserve peaks and dips
function downsample(points, getValue) {
  if (points.length <= CHART_RESOLUTION) return points;

  const bucketSize = points.length / CHART_RESOLUTION;
  const result = [];

  for (let i = 0; i < CHART_RESOLUTION; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    let minPoint = points[start], maxPoint = points[start];
    let minVal = getValue(points[start]), maxVal = minVal;

    for (let j = start + 1; j < end; j++) {
      const v = getValue(points[j]);
      if (v < minVal) { minVal = v; minPoint = points[j]; }
      if (v > maxVal) { maxVal = v; maxPoint = points[j]; }
    }

    if (minPoint.ts <= maxPoint.ts) {
      result.push(minPoint);
      if (minPoint !== maxPoint) result.push(maxPoint);
    } else {
      result.push(maxPoint);
      if (minPoint !== maxPoint) result.push(minPoint);
    }
  }

  return result;
}

function setupChart() {
  const canvas = document.getElementById('chart-canvas');
  if (!canvas) return;

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    drawChart();
    drawMotionStrip();
    drawEnergyStrip();
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  // Checkbox-style legend — clicking toggles each series on/off
  document.getElementById('chart-legend').addEventListener('click', (e) => {
    const btn = e.target.closest('.legend-btn');
    if (!btn) return;
    const key = btn.dataset.series;
    if (activeSeries.has(key)) {
      activeSeries.delete(key);
      btn.classList.remove('active');
    } else {
      activeSeries.add(key);
      btn.classList.add('active');
    }
    drawChart();
    drawMotionStrip();
    drawEnergyStrip();
  });

  // Time range buttons
  document.getElementById('time-range').addEventListener('click', (e) => {
    const btn = e.target.closest('.range-btn');
    if (!btn) return;
    selectedHours = parseInt(btn.dataset.hours);
    document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    drawChart();
    drawMotionStrip();
    drawEnergyStrip();
  });

  canvas.addEventListener('mousemove', (e) => showTooltip(e, canvas));
  canvas.addEventListener('mouseleave', () => {
    document.getElementById('chart-tooltip').style.display = 'none';
  });
}

// Single source of truth for chart padding — used by drawChart, showTooltip, and drawMotionStrip.
// When adding axes or labels that eat into the chart area, update ONLY this function.
function chartPad(dpr) {
  const hasRight = [...activeSeries].some(k => seriesConfig[k].axis === 'right');
  return { top: 25 * dpr, right: (hasRight ? 55 : 20) * dpr, bottom: 40 * dpr, left: 55 * dpr };
}

function drawChart() {
  const canvas = document.getElementById('chart-canvas');
  if (!canvas) return;
  const filtered = getFilteredPoints();
  if (filtered.length < 2) return;

  // Downsample each active series independently
  seriesData = {};
  for (const key of activeSeries) {
    const cfg = seriesConfig[key];
    const pts = cfg.filter ? filtered.filter(cfg.filter) : filtered;
    if (pts.length >= 2) {
      seriesData[key] = downsample(pts, cfg.getValue);
    }
  }

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const dpr = devicePixelRatio;

  const pad = chartPad(dpr);
  const cw = w - pad.left - pad.right;
  const ch = h - pad.top - pad.bottom;

  ctx.clearRect(0, 0, w, h);

  // Time range for X axis — pinned to the full filtered range so it stays
  // stable regardless of which series are checked (downsampling picks different endpoints)
  filteredTMin = filtered[0].ts;
  filteredTMax = filtered[filtered.length - 1].ts;
  const tMin = filteredTMin;
  const tMax = filteredTMax;
  const tRange = tMax - tMin || 1;

  // I compute Y ranges per axis — series on the same axis share a scale
  // so their values are directly comparable (e.g. X, Y, Z in µT).
  function computeRange(axis) {
    let yMin = Infinity, yMax = -Infinity;
    for (const key of activeSeries) {
      if (seriesConfig[key].axis !== axis || !seriesData[key]) continue;
      const getValue = seriesConfig[key].getValue;
      for (const p of seriesData[key]) {
        const v = getValue(p);
        if (v < yMin) yMin = v;
        if (v > yMax) yMax = v;
      }
    }
    if (yMin === Infinity) return null; // no active series on this axis
    if (yMin === yMax) { yMin -= 2; yMax += 2; }
    const range = yMax - yMin;
    return { min: yMin - range * 0.1, max: yMax + range * 0.1 };
  }

  const leftRange = computeRange('left');
  const rightRange = computeRange('right');

  function tx(ts) { return pad.left + ((ts - tMin) / tRange) * cw; }
  function tyLeft(v) { return pad.top + ((leftRange.max - v) / (leftRange.max - leftRange.min)) * ch; }
  function tyRight(v) { return pad.top + ((rightRange.max - v) / (rightRange.max - rightRange.min)) * ch; }

  // Grid lines
  ctx.strokeStyle = 'rgba(243, 179, 255, 0.1)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 5; i++) {
    const y = pad.top + (i / 5) * ch;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + cw, y);
    ctx.stroke();
  }

  // Left Y-axis labels
  if (leftRange) {
    ctx.fillStyle = '#CED1B6';
    ctx.font = `${10 * dpr}px -apple-system, sans-serif`;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (i / 5) * ch;
      const val = leftRange.max - (i / 5) * (leftRange.max - leftRange.min);
      ctx.fillText(val.toFixed(0), pad.left - 6 * dpr, y + 3 * dpr);
    }
  }

  // Right Y-axis labels
  if (rightRange) {
    ctx.fillStyle = '#CED1B6';
    ctx.font = `${10 * dpr}px -apple-system, sans-serif`;
    ctx.textAlign = 'left';
    for (let i = 0; i <= 5; i++) {
      const y = pad.top + (i / 5) * ch;
      const val = rightRange.max - (i / 5) * (rightRange.max - rightRange.min);
      ctx.fillText(Math.round(val).toString(), pad.left + cw + 6 * dpr, y + 3 * dpr);
    }
  }

  // Series labels at top — each active series in its own color
  ctx.font = `${11 * dpr}px -apple-system, sans-serif`;
  ctx.textAlign = 'left';
  let labelX = pad.left;
  let first = true;
  for (const key of activeSeries) {
    if (!seriesData[key]) continue;
    const cfg = seriesConfig[key];
    if (!first) {
      ctx.fillStyle = '#CED1B6';
      ctx.fillText(' · ', labelX, 14 * dpr);
      labelX += ctx.measureText(' · ').width;
    }
    ctx.fillStyle = cfg.color;
    const text = cfg.label + (cfg.unit ? ` (${cfg.unit})` : '');
    ctx.fillText(text, labelX, 14 * dpr);
    labelX += ctx.measureText(text).width;
    first = false;
  }

  // Time labels on X axis — evenly spaced across the full time range
  ctx.textAlign = 'center';
  ctx.fillStyle = '#CED1B6';
  ctx.font = `${10 * dpr}px -apple-system, sans-serif`;
  const numLabels = 6;
  for (let i = 0; i < numLabels; i++) {
    const ts = tMin + (i / (numLabels - 1)) * tRange;
    const x = tx(ts);
    let label;
    if (ts > 1000000000) {
      const d = new Date(ts * 1000);
      if (selectedHours <= 24) {
        label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      } else {
        label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
    } else {
      label = `${(ts / 1000).toFixed(0)}s`;
    }
    ctx.fillText(label, x, h - 8 * dpr);
  }

  // Draw each active series
  for (const key of activeSeries) {
    const pts = seriesData[key];
    if (!pts || pts.length < 2) continue;
    const cfg = seriesConfig[key];
    const tyFn = cfg.axis === 'left' ? tyLeft : tyRight;
    const range = cfg.axis === 'left' ? leftRange : rightRange;
    if (!range) continue;

    ctx.strokeStyle = cfg.color;
    ctx.lineWidth = 2 * dpr;
    ctx.lineJoin = 'round';
    ctx.setLineDash(cfg.axis === 'right' ? [6 * dpr, 3 * dpr] : []);
    ctx.beginPath();

    for (let i = 0; i < pts.length; i++) {
      const x = tx(pts[i].ts);
      const y = tyFn(cfg.getValue(pts[i]));
      if (i === 0) {
        ctx.moveTo(x, y);
      } else if (cfg.stepped) {
        // Step: horizontal then vertical — shows discrete jumps honestly
        ctx.lineTo(x, tyFn(cfg.getValue(pts[i - 1])));
        ctx.lineTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);

    // Fill under the line only when it's the sole active series
    if (activeSeries.size === 1 && !cfg.stepped) {
      ctx.lineTo(tx(pts[pts.length - 1].ts), pad.top + ch);
      ctx.lineTo(tx(pts[0].ts), pad.top + ch);
      ctx.closePath();
      ctx.fillStyle = cfg.color.slice(0, 7) + '15';
      ctx.fill();
    }
  }

  // Zero line if left-axis range spans zero
  if (leftRange && leftRange.min < 0 && leftRange.max > 0) {
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(pad.left, tyLeft(0));
    ctx.lineTo(pad.left + cw, tyLeft(0));
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// I draw a thin horizontal bar showing motion events aligned with the chart's X axis
function drawMotionStrip() {
  const strip = document.getElementById('motion-strip');
  if (!strip) return;

  const filtered = getFilteredPoints();
  if (filtered.length < 2) return;

  // Match the chart's left/right padding so the strip aligns with the chart
  const dpr = devicePixelRatio;
  const rect = strip.parentElement.getBoundingClientRect();
  strip.width = rect.width * dpr;
  strip.height = 18 * dpr;

  const pad = chartPad(dpr);
  const cw = strip.width - pad.left - pad.right;

  const ctx = strip.getContext('2d');
  ctx.clearRect(0, 0, strip.width, strip.height);

  const tMin = filtered[0].ts;
  const tMax = filtered[filtered.length - 1].ts;
  const tRange = tMax - tMin || 1;

  // I draw each motion=true sample as a small pink bar
  ctx.fillStyle = '#ffb3c6';
  const barW = Math.max(cw / filtered.length, 2 * dpr);
  for (const p of filtered) {
    if (p.pir.motion) {
      const x = pad.left + ((p.ts - tMin) / tRange) * cw;
      ctx.fillRect(x - barW / 2, 0, barW, strip.height);
    }
  }

  // Update motion percentage for the selected time range
  const motionCount = filtered.filter(p => p.pir.motion).length;
  const pct = ((motionCount / filtered.length) * 100).toFixed(1);
  const pctEl = document.getElementById('motion-pct');
  if (pctEl) {
    pctEl.textContent = `${pct}% (${motionCount} / ${filtered.length} samples)`;
    pctEl.style.color = motionCount > 0 ? '#ffb3c6' : '#CED1B6';
  }
}

// ── House Energy Strip ──────────────────────────────────────────────────────
// Drawing a color-coded timeline where each 1-hour chunk is classified as
// Connected (pink), Isolated (purple), or Empty (dim).
// Aligned horizontally with the main chart via chartPad().

let energyChunks = []; // Cached for tooltip lookup

function drawEnergyStrip() {
  const strip = document.getElementById('energy-strip');
  if (!strip) return;

  const filtered = getFilteredPoints();
  if (filtered.length < 2) return;

  energyChunks = classifyChunks(filtered);
  if (energyChunks.length === 0) return;

  const dpr = devicePixelRatio;
  const rect = strip.parentElement.getBoundingClientRect();
  strip.width = rect.width * dpr;
  strip.height = 32 * dpr;

  const pad = chartPad(dpr);
  const cw = strip.width - pad.left - pad.right;

  const ctx = strip.getContext('2d');
  ctx.clearRect(0, 0, strip.width, strip.height);

  const tMin = filtered[0].ts;
  const tMax = filtered[filtered.length - 1].ts;
  const tRange = tMax - tMin || 1;

  // Drawing each classified chunk as a colored block
  for (const chunk of energyChunks) {
    const x1 = pad.left + ((chunk.tsStart - tMin) / tRange) * cw;
    const x2 = pad.left + ((chunk.tsEnd - tMin) / tRange) * cw;
    const blockW = Math.max(x2 - x1, 1);

    ctx.fillStyle = ENERGY_COLORS[chunk.state];
    // Slight rounding on each block for visual softness
    const r = Math.min(3 * dpr, blockW / 2);
    ctx.beginPath();
    ctx.roundRect(x1, 2 * dpr, blockW, strip.height - 4 * dpr, r);
    ctx.fill();
  }

  // Updating the live state label in the Network panel
  updateEnergyLabel();
}

// Showing the current house energy state based on the most recent chunk
function updateEnergyLabel() {
  const el = document.getElementById('energy-state');
  if (!el) return;

  if (energyChunks.length === 0) {
    el.textContent = '—';
    el.style.color = '#CED1B6';
    return;
  }

  const latest = energyChunks[energyChunks.length - 1];
  el.textContent = ENERGY_LABELS[latest.state];
  el.style.color = ENERGY_COLORS[latest.state];
}

// Tooltip for the energy strip — shows chunk details on hover.
// All data comes from our own sensor JSON (not user-editable input),
// so the string construction here is safe from injection.
function setupEnergyTooltip() {
  const strip = document.getElementById('energy-strip');
  if (!strip) return;

  const tooltip = document.getElementById('energy-tooltip');
  if (!tooltip) return;

  strip.addEventListener('mousemove', (e) => {
    if (energyChunks.length === 0) return;

    const rect = strip.getBoundingClientRect();
    const dpr = devicePixelRatio;
    const pad = chartPad(dpr);
    const cw = strip.width - pad.left - pad.right;

    const filtered = getFilteredPoints();
    if (filtered.length < 2) return;
    const tMin = filtered[0].ts;
    const tMax = filtered[filtered.length - 1].ts;
    const tRange = tMax - tMin || 1;

    const mouseX = (e.clientX - rect.left) * dpr;
    const mouseTs = tMin + ((mouseX - pad.left) / cw) * tRange;

    // Finding which chunk the mouse is over
    const chunk = energyChunks.find(c => mouseTs >= c.tsStart && mouseTs < c.tsEnd);
    if (!chunk) { tooltip.style.display = 'none'; return; }

    const startTime = formatTimestamp(chunk.tsStart);
    const endTime = formatTimestamp(chunk.tsEnd);
    const wifiText = chunk.wifiAvg >= 0 ? chunk.wifiAvg.toFixed(0) + ' devices' : 'no data';

    // Building tooltip from sensor-generated values only (no user input)
    tooltip.textContent = '';
    const stateDiv = document.createElement('div');
    stateDiv.style.cssText = 'font-weight:600;margin-bottom:4px';
    stateDiv.style.color = ENERGY_COLORS[chunk.state];
    stateDiv.textContent = ENERGY_LABELS[chunk.state];
    tooltip.appendChild(stateDiv);

    for (const text of [
      startTime + ' — ' + endTime,
      'WiFi: ' + wifiText,
      'PIR \u03C3: ' + chunk.pirRawStd.toFixed(1),
      'Z \u03C3: ' + chunk.zStd.toFixed(2) + ' \u00B5T'
    ]) {
      const div = document.createElement('div');
      div.style.color = '#CED1B6';
      div.textContent = text;
      tooltip.appendChild(div);
    }

    tooltip.style.display = 'block';
    const tipX = e.clientX - rect.left;
    if (tipX > rect.width * 0.7) {
      tooltip.style.left = (tipX - tooltip.offsetWidth - 12) + 'px';
    } else {
      tooltip.style.left = (tipX + 12) + 'px';
    }
    tooltip.style.top = '-60px';
  });

  strip.addEventListener('mouseleave', () => {
    tooltip.style.display = 'none';
  });
}

function showTooltip(e, canvas) {
  // I snap to the nearest point from the first active series that has data
  const firstKey = [...activeSeries].find(k => seriesData[k] && seriesData[k].length >= 2);
  if (!firstKey) return;
  const snapPoints = seriesData[firstKey];

  const tooltip = document.getElementById('chart-tooltip');
  const rect = canvas.getBoundingClientRect();
  const dpr = devicePixelRatio;

  const pad = chartPad(dpr);
  const cw = canvas.width - pad.left - pad.right;
  const tMin = filteredTMin;
  const tMax = filteredTMax;

  const mouseX = (e.clientX - rect.left) * dpr;
  const mouseTs = tMin + ((mouseX - pad.left) / cw) * (tMax - tMin);

  let closest = 0;
  let minDist = Infinity;
  for (let i = 0; i < snapPoints.length; i++) {
    const dist = Math.abs(snapPoints[i].ts - mouseTs);
    if (dist < minDist) { minDist = dist; closest = i; }
  }

  const p = snapPoints[closest];

  // Building tooltip — all values come from our own sensor JSON, not user input
  let lines = `<div style="color:#CED1B6;margin-bottom:4px">${formatTimestamp(p.ts)}</div>`;
  for (const key of activeSeries) {
    const cfg = seriesConfig[key];
    if (cfg.filter && !cfg.filter(p)) continue;
    const val = cfg.getValue(p);
    const formatted = (typeof val === 'number') ? val.toFixed(1) : val;
    lines += `<div style="color:${cfg.color}">${cfg.label}: ${formatted} ${cfg.unit}</div>`;
  }
  lines += `<div style="color:${p.pir.motion ? '#ffb3c6' : '#CED1B6'}">${p.pir.motion ? 'Motion' : 'Clear'}</div>`;

  tooltip.innerHTML = lines;
  tooltip.style.display = 'block';

  const tipX = e.clientX - rect.left;
  const tipY = e.clientY - rect.top;
  if (tipX > rect.width * 0.7) {
    tooltip.style.left = (tipX - tooltip.offsetWidth - 12) + 'px';
  } else {
    tooltip.style.left = (tipX + 12) + 'px';
  }
  tooltip.style.top = (tipY - 20) + 'px';
}

window.addEventListener('DOMContentLoaded', setup);
