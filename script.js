const MAX_HISTORY = 10;
let dataPoints = [];
let lastLineCount = 0;

function setup() {
  setInterval(fetchText, 1000);
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
        if (parsed.mag && parsed.pir) dataPoints.push(parsed);
      } catch (e) {
        // skip malformed lines
      }
    }

    if (dataPoints.length > MAX_HISTORY) {
      dataPoints = dataPoints.slice(-MAX_HISTORY);
    }

    lastLineCount = lines.length;
    updateLiveReading();
    updateHistory();
  }
}

function updateLiveReading() {
  if (dataPoints.length === 0) return;
  const latest = dataPoints[dataPoints.length - 1];

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
}

// BMM150 range is ±1300 µT for X/Y, ±2500 µT for Z — use 1300 as a common scale
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
  const reversedPoints = [...dataPoints].reverse();

  reversedPoints.forEach((point, index) => {
    const entry = document.createElement('div');
    entry.className = 'data-entry' + (index > 0 ? ' old' : '');
    entry.innerHTML = `
      <div class="timestamp">t+${(point.ts / 1000).toFixed(0)}s</div>
      <div class="values">
        <span>X: ${point.mag.x.toFixed(1)} µT</span>
        <span>Y: ${point.mag.y.toFixed(1)} µT</span>
        <span>Z: ${point.mag.z.toFixed(1)} µT</span>
        <span>|B|: ${point.mag.mag.toFixed(1)} µT</span>
        <span class="${point.pir.motion ? 'motion-yes' : 'motion-no'}">PIR: ${point.pir.motion ? 'motion' : 'clear'} (${point.pir.raw})</span>
      </div>
    `;
    container.appendChild(entry);
  });
}

window.addEventListener('DOMContentLoaded', setup);
