/* dashboard.js — DLR Monitoring Dashboard */

'use strict';

// ── State ──────────────────────────────────────────────────
let monView   = 'yearly';   // 'yearly' | 'monthly' | 'daily'
let monMonth  = 1;
let monDate   = '2021-01-01';
let currentMode  = 'all';
let currentMonth = 0;
let currentRes   = 'D';
let charts       = {};

const SLR = 1434;

// ── Colour palette ─────────────────────────────────────────
const C = {
  calc:    '#2563eb',
  sensor:  '#16a34a',
  fore:    '#9333ea',
  slr:     '#dc2626',
  ta:      '#f97316',
  ts:      '#dc2626',
  wind:    '#0891b2',
  load:    '#7c3aed',
  gain:    '#16a34a',
  loss:    '#dc2626',
  normal:  '#2563eb',
  hw:      '#dc2626',
};

// ── Chart.js global defaults — set inside init() after defer loads ───────────
function setupChartDefaults() {
  if (typeof Chart === 'undefined') return;
  Chart.defaults.font.family = "'Segoe UI', Arial, sans-serif";
  Chart.defaults.font.size   = 11;
  Chart.defaults.color       = '#64748b';
}

// ── Helpers ────────────────────────────────────────────────
function gridOpts() {
  return { color: 'rgba(0,0,0,0.06)' };
}
function tickOpts() {
  return { color: '#94a3b8', maxTicksLimit: 8 };
}
function destroyChart(id) {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}
async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

// ── KPI cards ──────────────────────────────────────────────
async function loadSummary() {
  // Pass current month + mode so cards reflect the same filter as the chart
  const url = `/api/summary?month=${currentMonth}&mode=${currentMode}`;
  const d   = await fetchJSON(url);

  // Helper: format a value that may be null (e.g. no heatwave hours in a cool month)
  const fmtA = v => v != null ? v + ' <span class="kpi-unit">A</span>' : '— <span class="kpi-unit">A</span>';
  const fmtP = v => v != null ? v + '<span class="kpi-unit">%</span>'  : '—<span class="kpi-unit">%</span>';

  setText('kpi-dlr-normal',   fmtA(d.mean_dlr_calc_normal));
  setText('kpi-dlr-heat',     fmtA(d.mean_dlr_calc_heatwave));
  setText('kpi-above-slr',    fmtP(d.pct_above_slr));
  setText('kpi-above-hrs',    d.hours_above_slr + ' of ' + d.total_hours + ' hrs');
  setText('kpi-hw-hours',     d.heatwave_hours);
  setText('kpi-sensor-dlr',   fmtA(d.mean_dlr_sensor));

  // Dynamic sub-labels showing the active period
  setText('kpi-period-label', d.period_label);
  setText('kpi-hw-sub',       'Ta ≥ 32°C · ' + d.period_label);

  // DLR vs SLR difference arrows
  if (d.mean_dlr_calc_normal != null) {
    const diffN = (d.mean_dlr_calc_normal - SLR).toFixed(1);
    setText('kpi-dlr-normal-diff', (diffN >= 0 ? '▲ +' : '▼ ') + diffN + ' A vs SLR');
  } else {
    setText('kpi-dlr-normal-diff', 'No normal-condition data');
  }
  if (d.mean_dlr_calc_heatwave != null) {
    const diffH = (d.mean_dlr_calc_heatwave - SLR).toFixed(1);
    setText('kpi-dlr-heat-diff', (diffH >= 0 ? '▲ +' : '▼ ') + diffH + ' A vs SLR');
  } else {
    setText('kpi-dlr-heat-diff', 'No heatwave data in this period');
  }
}

function setText(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// ── Main ampacity chart — Plotly, full hourly detail on daily view ───────────
async function loadTimeSeries() {
  // Build API URL based on view mode
  let apiUrl;
  if (monView === 'yearly') {
    apiUrl = `/api/timeseries?month=0&mode=${currentMode}&resample=D`;
    currentMonth = 0;
  } else if (monView === 'monthly') {
    apiUrl = `/api/timeseries?month=${monMonth}&mode=${currentMode}&resample=D`;
    currentMonth = monMonth;
  } else {
    // daily — use risk_monitor API for full hourly resolution
    apiUrl = `/api/risk_monitor?view=daily&date=${encodeURIComponent(monDate)}`;
  }

  const raw = await fetchJSON(apiUrl);
  const isDailyView = (monView === 'daily');

  // Normalise key names — risk_monitor uses dlr_calc, timeseries uses dlr_calculated
  const d = isDailyView ? {
    ...raw,
    dlr_calculated: raw.dlr_calc,
    wind_speed:     raw.wind_speed,
    wind_dir:       raw.wind_dir,
    ta:             raw.ta,
    ts:             raw.ta,   // no Ts in risk_monitor, use Ta as fallback
    load:           raw.load,
    slr:            Array(raw.labels.length).fill(1434),
    is_heatwave:    raw.labels.map((_,i) => raw.ta && raw.ta[i] >= 32 ? 1 : 0),
  } : raw;

  const labels       = d.labels;
  const dlr_calc     = d.dlr_calculated;
  const dlr_sensor   = d.dlr_sensor;
  const dlr_forecast = d.dlr_forecast;
  const wind_speed   = d.wind_speed;
  const wind_dir     = d.wind_dir;
  const ta           = d.ta;
  const n = labels.length;

  // Update chart title
  const titleEl = document.getElementById('mon-chart-title');
  if (titleEl) {
    if (monView === 'daily')   titleEl.textContent = 'Ampacity — ' + monDate + ' (Hourly)';
    else if (monView === 'monthly') titleEl.textContent = 'Ampacity — ' + document.getElementById('mon-month-sel').options[document.getElementById('mon-month-sel').selectedIndex].text + ' 2021 (Daily avg)';
    else titleEl.textContent = 'Ampacity — Full Year 2021 (Daily avg)';
  }

  // Build hover text
  function toCard(deg) {
    if (deg == null) return '—';
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }
  function fv(v, dp=1) { return v == null ? '—' : (+v).toFixed(dp); }

  const hoverText = labels.map((lbl, i) => [
    `<b>${lbl}</b>`,
    `─────────────────────`,
    `DLR Calculated : <b>${fv(dlr_calc[i])} A</b>`,
    `DLR Sensor     : <b>${fv(dlr_sensor[i])} A</b>`,
    `DLR Forecast   : <b>${fv(dlr_forecast[i])} A</b>`,
    `SLR (Fixed)    : <b>1434 A</b>`,
    `─────────────────────`,
    `Wind Speed     : ${fv(wind_speed ? wind_speed[i] : null, 2)} m/s`,
    `Wind Direction : ${fv(wind_dir ? wind_dir[i] : null, 0)}° (${toCard(wind_dir ? wind_dir[i] : null)})`,
    `Ambient Temp   : ${fv(ta ? ta[i] : null, 1)} °C`,
  ].join('<br>'));

  // SLR % reference lines — above SLR to show DLR capacity gain
  const slrPctLines = [110, 120, 130, 140].map(pct => ({
    x: [labels[0], labels[n-1]], y: [SLR*pct/100, SLR*pct/100],
    name: `${pct}% SLR (${(SLR*pct/100).toFixed(0)} A)`,
    type: 'scatter', mode: 'lines',
    line: { color: '#94a3b8', width: 1, dash: 'dot' },
    hoverinfo: 'skip', showlegend: true,
  }));

  const traces = [
    {
      x: labels, y: dlr_calc,
      name: 'DLR Calculated', type: 'scatter', mode: 'lines',
      line: { color: '#2563eb', width: 2 },
      hoverinfo: 'text', hovertext: hoverText,
      hoverlabel: { bgcolor: '#0f172a', bordercolor: '#334155',
                    font: { color: '#e2e8f0', size: 11, family: 'monospace' }, align: 'left' },
    },
    {
      x: labels, y: dlr_sensor,
      name: 'DLR Sensor', type: 'scatter', mode: 'lines',
      line: { color: 'rgba(22,163,74,0.8)', width: 1.5, dash: 'dot' },
      hoverinfo: 'skip',
    },
    {
      x: labels, y: dlr_forecast,
      name: 'DLR Forecast', type: 'scatter', mode: 'lines',
      line: { color: 'rgba(147,51,234,0.7)', width: 1.5, dash: 'dashdot' },
      hoverinfo: 'skip',
    },
    {
      x: [labels[0], labels[n-1]], y: [SLR, SLR],
      name: 'SLR = 1434 A', type: 'scatter', mode: 'lines',
      line: { color: '#dc2626', width: 2, dash: 'dash' },
      hoverinfo: 'skip',
    },
    ...slrPctLines,
  ];

  // ── X-axis range: lock to selected period so no empty space ──────────────
  // For monthly: first to last day of that month
  // For daily: start to end of that day
  // For yearly: full year
  let xRange = null;
  if (monView === 'monthly' && labels.length > 0) {
    xRange = [labels[0], labels[labels.length - 1]];
  } else if (monView === 'daily' && labels.length > 0) {
    xRange = [labels[0], labels[labels.length - 1]];
  }

  const layout = {
    autosize: true,
    paper_bgcolor: '#ffffff',
    plot_bgcolor:  '#f8fafc',
    margin: { t: 60, r: 110, b: 80, l: 65 },
    xaxis: {
      title: { text: monView === 'daily' ? 'Time' : 'Date', font: { size: 12 } },
      showgrid: true,
      gridcolor: '#e2e8f0',
      rangeslider: { visible: true, thickness: 0.05 },
      tickangle: -30,
      type: 'category',
      nticks: monView === 'daily' ? 24 : (monView === 'monthly' ? labels.length : 12),
      ...(xRange ? { range: [xRange[0], xRange[1]] } : {}),
    },
    yaxis: {
      title: { text: 'Current / Ampacity (A)', font: { size: 12 } },
      showgrid: true,
      gridcolor: '#e2e8f0',
      rangemode: 'tozero',
    },
    legend: {
      orientation: 'h',
      x: 0, y: 1.08,
      font: { size: 11 },
      bgcolor: 'rgba(255,255,255,0.85)',
    },
    hovermode: 'closest',
    annotations: [
      { xref:'paper', yref:'y', x:1.002, y:SLR,
        text:'SLR = 1434 A', showarrow:false,
        font:{ color:'#dc2626', size:10 }, xanchor:'left' },
      ...[110, 120, 130, 140].map(pct => ({
        xref:'paper', yref:'y', x:1.002, y:SLR * pct / 100,
        text:`${pct}% (${(SLR * pct / 100).toFixed(0)} A)`,
        showarrow:false, font:{ color:'#94a3b8', size:9 }, xanchor:'left',
      })),
    ],
  };

  try {
    Plotly.react('mon-plotly-chart', traces, layout,
      { responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d'],
        displaylogo: false,
        scrollZoom: true });
  } catch(e) { console.error('Plotly.react mon chart failed:', e); }

  // Update secondary Chart.js charts using the same normalised data
  // For daily: d already has all fields; for yearly/monthly: re-fetch at correct resolution
  try {
    if (isDailyView) {
      buildSecondaryCharts(d);
    } else {
      const secUrl = `/api/timeseries?month=${currentMonth}&mode=${currentMode}&resample=D`;
      const sd = await fetchJSON(secUrl);
      buildSecondaryCharts(sd);
    }
  } catch(e) { console.error('buildSecondaryCharts failed:', e); }
}

function buildSecondaryCharts(d) {
  if (!d || !d.labels) return;
  // Temperature chart
  destroyChart('tempChart');
  const ctx2 = document.getElementById('tempChart').getContext('2d');
  charts.tempChart = new Chart(ctx2, {
    type: 'line',
    data: {
      labels: d.labels,
      datasets: [
        { label: 'Conductor Ts (°C)', data: d.ts,  borderColor: C.ts,  borderWidth: 2, pointRadius: 0, tension: 0.3 },
        { label: 'Ambient Ta (°C)',   data: d.ta,  borderColor: C.ta,  borderWidth: 2, pointRadius: 0, tension: 0.3, borderDash: [4,2] },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: gridOpts(), ticks: { ...tickOpts(), maxTicksLimit: 8 } },
        y: { grid: gridOpts(), ticks: tickOpts(),
          title: { display: true, text: 'Temperature (°C)', font: { size: 11 } } },
      },
    },
  });

  // Wind & load chart
  destroyChart('windChart');
  const ctx3 = document.getElementById('windChart').getContext('2d');
  charts.windChart = new Chart(ctx3, {
    type: 'line',
    data: {
      labels: d.labels,
      datasets: [
        { label: 'Wind Speed (m/s)', data: d.wind_speed, borderColor: C.wind, borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'y' },
        { label: 'Load (A)',         data: d.load,       borderColor: C.load, borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: 'y2' },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: false } },
      scales: {
        x:  { grid: gridOpts(), ticks: { ...tickOpts(), maxTicksLimit: 8 } },
        y:  { grid: gridOpts(), ticks: tickOpts(), position: 'left',
              title: { display: true, text: 'Wind (m/s)', font: { size: 11 } } },
        y2: { grid: { display: false }, ticks: tickOpts(), position: 'right',
              title: { display: true, text: 'Load (A)', font: { size: 11 } } },
      },
    },
  });

  // Gain chart
  destroyChart('gainChart');
  const ctx4 = document.getElementById('gainChart').getContext('2d');
  const gainColors = d.dlr_calculated.map(v => v === null ? '#94a3b8' : (v > SLR ? C.gain : C.loss));
  const gainData   = d.dlr_calculated.map(v => v === null ? null : v - SLR);
  charts.gainChart = new Chart(ctx4, {
    type: 'bar',
    data: {
      labels: d.labels,
      datasets: [{
        label: 'DLR − SLR (A)',
        data: gainData,
        backgroundColor: gainColors,
        borderWidth: 0,
        barPercentage: 0.9,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: gridOpts(), ticks: { ...tickOpts(), maxTicksLimit: 10 } },
        y: { grid: gridOpts(), ticks: tickOpts(),
          title: { display: true, text: 'DLR − SLR (A)', font: { size: 11 } } },
      },
    },
  });
}

// ── Monthly chart ───────────────────────────────────────────
async function loadMonthly() {
  const d = await fetchJSON('/api/monthly');
  destroyChart('monthlyChart');
  const ctx = document.getElementById('monthlyChart').getContext('2d');
  charts.monthlyChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: d.labels,
      datasets: [
        { label: 'DLR Calculated', data: d.dlr_calc,   backgroundColor: C.calc + 'cc', borderRadius: 3 },
        { label: 'DLR Sensor',     data: d.dlr_sensor, backgroundColor: C.sensor + 'cc', borderRadius: 3 },
        { label: 'SLR 1434 A',     data: d.slr,
          type: 'line', borderColor: C.slr, borderWidth: 2, borderDash: [5,3],
          pointRadius: 0, fill: false },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: gridOpts(), ticks: tickOpts() },
        y: { grid: gridOpts(), ticks: tickOpts(),
          title: { display: true, text: 'Ampacity (A)', font: { size: 11 } } },
      },
    },
  });
}

// ── Heatwave comparison chart ───────────────────────────────
async function loadHeatwaveCompare() {
  const d = await fetchJSON('/api/heatwave_compare');
  destroyChart('hwCompareChart');
  const ctx = document.getElementById('hwCompareChart').getContext('2d');
  charts.hwCompareChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: d.categories,
      datasets: [
        { label: 'Normal (Ta < 32°C)',    data: d.normal,   backgroundColor: C.normal + 'cc', borderRadius: 3 },
        { label: 'Heatwave (Ta ≥ 32°C)', data: d.heatwave, backgroundColor: C.hw    + 'cc', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: { boxWidth: 10, font: { size: 11 } },
        },
      },
      scales: {
        x: { grid: gridOpts(), ticks: tickOpts() },
        y: {
          grid: gridOpts(), ticks: tickOpts(),
          title: { display: true, text: 'Ampacity (A)', font: { size: 11 } },
          min: 1200,
        },
      },
    },
  });
}

// ── Validation scatter chart ────────────────────────────────
async function loadValidation() {
  const d = await fetchJSON('/api/validation');

  // Build scatter datasets split by heatwave flag
  const normalPts = [], hwPts = [];
  d.sensor.forEach((s, i) => {
    const pt = { x: s, y: d.calculated[i] };
    if (d.is_heatwave[i]) hwPts.push(pt);
    else normalPts.push(pt);
  });

  // Perfect-fit diagonal
  const allVals  = d.sensor.filter(Boolean);
  const minV = Math.min(...allVals) * 0.95;
  const maxV = Math.max(...allVals) * 1.05;
  const diagLine = [{ x: minV, y: minV }, { x: maxV, y: maxV }];

  destroyChart('scatterChart');
  const ctx = document.getElementById('scatterChart').getContext('2d');
  charts.scatterChart = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [
        {
          label: 'Normal',
          data: normalPts,
          backgroundColor: C.normal + '66',
          pointRadius: 3,
        },
        {
          label: 'Heatwave',
          data: hwPts,
          backgroundColor: C.hw + '99',
          pointRadius: 3,
        },
        {
          label: 'Perfect fit',
          data: diagLine,
          type: 'line',
          borderColor: '#64748b',
          borderWidth: 1.5,
          borderDash: [5, 3],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: gridOpts(), ticks: tickOpts(),
          title: { display: true, text: 'DLR Sensor (A)', font: { size: 11 } } },
        y: { grid: gridOpts(), ticks: tickOpts(),
          title: { display: true, text: 'DLR Calculated (A)', font: { size: 11 } } },
      },
    },
  });
}

// ── Validation metrics table ────────────────────────────────
async function loadMetrics() {
  const d = await fetchJSON('/api/validation_metrics');
  const el = document.getElementById('metrics-table');

  // ── Colour + label helpers ──────────────────────────────
  function mapeRating(v) {
    if (v < 10) return { cls: 'vm-good',  label: 'Good accuracy' };
    if (v < 20) return { cls: 'vm-warn',  label: 'Acceptable' };
    return              { cls: 'vm-poor',  label: 'Needs improvement' };
  }
  function rRating(v) {
    if (v > 0.7) return { cls: 'vm-good', label: 'Strong correlation' };
    if (v > 0.4) return { cls: 'vm-warn', label: 'Moderate correlation' };
    return               { cls: 'vm-poor', label: 'Weak correlation' };
  }
  function errRating(v, threshold) {   // lower = better, no fixed threshold
    return { cls: 'vm-neutral', label: '' };
  }

  // ── Single metric mini-card ─────────────────────────────
  function metricCard(label, value, unit, ratingFn, ratingArg) {
    const rt = ratingFn ? ratingFn(ratingArg != null ? ratingArg : value) : { cls: 'vm-neutral', label: '' };
    return `
      <div class="vm-card ${rt.cls}">
        <div class="vm-card-label">${label}</div>
        <div class="vm-card-value">${value}<span class="vm-card-unit"> ${unit}</span></div>
        ${rt.label ? `<div class="vm-card-tag">${rt.label}</div>` : ''}
      </div>`;
  }

  // ── One group (Overall / Normal / Heatwave) ─────────────
  function group(title, m, groupId, active) {
    if (!m) return `
      <div class="vm-group-panel" id="vmpanel-${groupId}" ${active ? '' : 'style="display:none"'}>
        <p class="vm-no-data">No heatwave data in this dataset period.</p>
      </div>`;
    const n = (m.n != null && m.n !== undefined) ? m.n.toLocaleString() : '—';
    return `
      <div class="vm-group-panel" id="vmpanel-${groupId}" ${active ? '' : 'style="display:none"'}>
        <div class="vm-cards-grid">
          ${metricCard('MAE',      m.mae.toFixed(1),  'A',    null,       null)}
          ${metricCard('RMSE',     m.rmse.toFixed(1), 'A',    null,       null)}
          ${metricCard('MAPE',     m.mape.toFixed(2), '%',    mapeRating, m.mape)}
          ${metricCard('Pearson r',m.r.toFixed(4),    '',     rRating,    m.r)}
          ${metricCard('n (hours)',n,                 'hrs',  null,       null)}
        </div>
      </div>`;
  }

  // ── Tab buttons ─────────────────────────────────────────
  const tabs = `
    <div class="vm-tabs">
      <button class="vm-tab active" onclick="vmSwitch('overall',this)">Overall</button>
      <button class="vm-tab" onclick="vmSwitch('normal',this)">Normal</button>
      <button class="vm-tab" onclick="vmSwitch('heatwave',this)">Heatwave</button>
    </div>`;

  // ── Summary blurb ───────────────────────────────────────
  const blurb = `
    <div class="vm-blurb">
      Compares IEEE 738 calculated DLR against sensor DLR.
      Lower MAE/RMSE/MAPE = better agreement. Higher Pearson r = stronger trend similarity.
    </div>`;

  el.innerHTML = blurb + tabs +
    group('Overall',          d.overall,  'overall',  true)  +
    group('Normal Periods',   d.normal,   'normal',   false) +
    group('Heatwave Periods', d.heatwave, 'heatwave', false);
}

// Tab switcher — must be global so onclick can call it
function vmSwitch(id, btn) {
  document.querySelectorAll('.vm-group-panel').forEach(p => p.style.display = 'none');
  document.querySelectorAll('.vm-tab').forEach(b => b.classList.remove('active'));
  const panel = document.getElementById('vmpanel-' + id);
  if (panel) panel.style.display = 'block';
  btn.classList.add('active');
}

// ── Badge update ────────────────────────────────────────────
function updateBadge() {
  const badge = document.getElementById('mode-badge');
  if (currentMode === 'heatwave') {
    badge.textContent = 'Heatwave';
    badge.classList.add('heatwave');
  } else {
    badge.textContent = 'Normal';
    badge.classList.remove('heatwave');
  }
}

// ── refreshMonitoring — reads DOM, updates state, reloads cards + chart ───────
async function refreshMonitoring() {
  monView  = document.getElementById('mon-view').value;
  monMonth = parseInt(document.getElementById('mon-month-sel').value) || 1;
  monDate  = document.getElementById('mon-date-sel').value || '';

  const activeMode = document.querySelector('#mode-toggle-group .toggle.active');
  currentMode = activeMode ? activeMode.dataset.mode : 'all';

  // Sync legacy currentMonth for secondary charts and summary API
  currentMonth = (monView === 'monthly') ? monMonth : 0;

  updateBadge();
  await Promise.all([ loadSummary(), loadTimeSeries() ]);
}

// ── Initialise date dropdown from API ────────────────────────────────────────
async function initMonControls() {
  const meta = await fetchJSON('/api/risk_dates');
  const dSel = document.getElementById('mon-date-sel');
  meta.dates.forEach(d => {
    const o = document.createElement('option');
    o.value = d; o.textContent = d;
    dSel.appendChild(o);
  });
  if (meta.dates.length) monDate = meta.dates[0];
}

// ── View dropdown show/hide sub-controls ─────────────────────────────────────
document.getElementById('mon-view').addEventListener('change', function() {
  document.getElementById('mon-month-group').style.display = this.value === 'monthly' ? 'flex' : 'none';
  document.getElementById('mon-date-group').style.display  = this.value === 'daily'   ? 'flex' : 'none';
  refreshMonitoring();
});

document.getElementById('mon-month-sel').addEventListener('change', () => refreshMonitoring());
document.getElementById('mon-date-sel').addEventListener('change',  () => refreshMonitoring());

document.querySelectorAll('#mode-toggle-group .toggle[data-mode]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#mode-toggle-group .toggle').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    refreshMonitoring();
  });
});

// ── Boot ──────────────────────────────────────────────────────────────────────
(async function init() {
  setupChartDefaults();
  try {
    await initMonControls();
  } catch(e) { console.error('initMonControls failed:', e); }

  try {
    await loadSummary();
  } catch(e) { console.error('loadSummary failed:', e); }

  try { await loadTimeSeries(); }
  catch(e) { console.error('loadTimeSeries failed:', e); }

  try { await loadMonthly(); }
  catch(e) { console.error('loadMonthly failed:', e); }

  try { await loadHeatwaveCompare(); }
  catch(e) { console.error('loadHeatwaveCompare failed:', e); }

  try { await loadValidation(); }
  catch(e) { console.error('loadValidation failed:', e); }

  try { await loadMetrics(); }
  catch(e) { console.error('loadMetrics failed:', e); }

  // Load wind analysis (non-blocking — loads after main charts)
  try { await loadWindAnalysis(); }
  catch(e) { console.error('loadWindAnalysis failed:', e); }
})();

// ═══════════════════════════════════════════════════════════
// TAB SWITCHING
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-monitoring').style.display = tab === 'monitoring' ? 'block' : 'none';
    document.getElementById('tab-risk').style.display       = tab === 'risk'       ? 'block' : 'none';
    document.getElementById('tab-location').style.display   = tab === 'location'   ? 'block' : 'none';
    if (tab === 'risk' && !window._riskLoaded) {
      window._riskLoaded = true;
      initRiskMonitor();
    }
    if (tab === 'location' && !window._mapLoaded) {
      window._mapLoaded = true;
      // Small delay so the div is visible before Leaflet measures it
      setTimeout(initStudyMap, 80);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// OPERATIONAL RISK MONITOR
// ═══════════════════════════════════════════════════════════

// Cardinal direction helper
function toCardinal(deg) {
  if (deg == null) return '—';
  const d = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return d[Math.round(deg / 22.5) % 16];
}
function fmt(v, dp=1, suffix='') {
  return v == null ? '—' : v.toFixed(dp) + suffix;
}

// Risk colour map
const RISK_COLOURS = {
  'Safe':       'rgba(22,163,74,0.0)',
  'Caution':    'rgba(234,179,8,0.18)',
  'Risky':      'rgba(234,88,12,0.22)',
  'Very Risky': 'rgba(220,38,38,0.30)',
};
const RISK_LINE = {
  'Safe':       'rgba(22,163,74,0)',
  'Caution':    'rgba(234,179,8,0.5)',
  'Risky':      'rgba(234,88,12,0.7)',
  'Very Risky': 'rgba(220,38,38,0.9)',
};

async function initRiskMonitor() {
  // Populate month and date dropdowns
  const meta = await fetchJSON('/api/risk_dates');
  const mSel = document.getElementById('risk-month');
  const dSel = document.getElementById('risk-date');
  meta.months.forEach(m => {
    const o = document.createElement('option');
    o.value = m.value; o.textContent = m.label;
    mSel.appendChild(o);
  });
  meta.dates.forEach(d => {
    const o = document.createElement('option');
    o.value = d; o.textContent = d;
    dSel.appendChild(o);
  });

  // View dropdown change handler
  document.getElementById('risk-view').addEventListener('change', function() {
    document.getElementById('risk-month-group').style.display = this.value === 'monthly' ? 'flex' : 'none';
    document.getElementById('risk-date-group').style.display  = this.value === 'daily'   ? 'flex' : 'none';
  });

  loadRiskMonitor();
}

async function loadRiskMonitor() {
  const view  = document.getElementById('risk-view').value;
  const month = document.getElementById('risk-month').value || 1;
  const date  = document.getElementById('risk-date').value  || '';
  const url   = `/api/risk_monitor?view=${view}&month=${month}&date=${encodeURIComponent(date)}`;
  const d     = await fetchJSON(url);

  updateRiskCards(d.summary);
  buildPlotlyChart(d);
}

function updateRiskCards(s) {
  document.getElementById('rk-max-load').textContent    = fmt(s.max_load, 1);
  document.getElementById('rk-mean-load').textContent   = fmt(s.mean_load, 1);
  document.getElementById('rk-max-dlrc').textContent    = fmt(s.max_dlr_calc, 1);
  document.getElementById('rk-mean-dlrc').textContent   = fmt(s.mean_dlr_calc, 1);
  document.getElementById('rk-min-margin').textContent  = fmt(s.min_margin_dlrc, 2);
  document.getElementById('rk-risky-pct').textContent   = fmt(s.risky_pct, 2);
  document.getElementById('rk-above80').textContent     = fmt(s.above80_pct, 2);
  document.getElementById('rk-above90').textContent     = fmt(s.above90_pct, 2);
  document.getElementById('rd-safe').textContent        = s.risk_counts['Safe'];
  document.getElementById('rd-caution').textContent     = s.risk_counts['Caution'];
  document.getElementById('rd-risky').textContent       = s.risk_counts['Risky'];
  document.getElementById('rd-vr').textContent          = s.risk_counts['Very Risky'];
  // Reset highlight state whenever new data loads
  _activeHighlight = null;
  document.querySelectorAll('.rdot').forEach(el => el.classList.remove('hl-active'));
}

// Store latest chart data for highlight toggle
let _riskChartData = null;
let _activeHighlight = null;  // 'Caution' | 'Risky' | 'Very Risky' | null

function buildPlotlyChart(d) {
  _riskChartData = d;   // save for re-use by highlight buttons
  const SLR_VAL = 1434;
  const n = d.labels.length;

  // ── Build risk background shapes (vrect-style via scatter fill) ──
  // Group consecutive same-risk rows into spans for shading
  const shapes = [];
  let spanStart = 0;
  for (let i = 1; i <= n; i++) {
    const curRisk = d.risk[i - 1];
    const nxtRisk = i < n ? d.risk[i] : null;
    if (curRisk !== nxtRisk || i === n) {
      if (curRisk !== 'Safe') {
        shapes.push({
          type: 'rect',
          xref: 'x', yref: 'paper',
          x0: d.labels[spanStart], x1: d.labels[i - 1],
          y0: 0, y1: 1,
          fillcolor: RISK_COLOURS[curRisk],
          line: { width: 0 },
          layer: 'below',
        });
      }
      spanStart = i;
    }
  }

  // ── Custom hover text for each point ──
  const hoverText = d.labels.map((lbl, i) => {
    const wd = d.wind_dir[i];
    return [
      `<b>${lbl}</b>`,
      `─────────────────────────────`,
      `Load Current      : <b>${fmt(d.load[i],1)} A</b>`,
      `SLR (Fixed)       : <b>1434 A</b>`,
      `DLR Calculated    : <b>${fmt(d.dlr_calc[i],1)} A</b>`,
      `DLR Sensor        : <b>${fmt(d.dlr_sensor[i],1)} A</b>`,
      `DLR Forecast      : <b>${fmt(d.dlr_forecast[i],1)} A</b>`,
      `─────────────────────────────`,
      `Ambient Temp      : ${fmt(d.ta[i],1)} °C`,
      `Wind Speed        : ${fmt(d.wind_speed[i],2)} m/s`,
      `Wind Direction    : ${fmt(d.wind_dir[i],0)}° (${toCardinal(wd)})`,
      `─────────────────────────────`,
      `Load / SLR        : ${fmt(d.load_slr_pct[i],1)} %`,
      `Load / DLR Calc   : ${fmt(d.load_dlrc_pct[i],1)} %`,
      `Load / DLR Sensor : ${fmt(d.load_dlrs_pct[i],1)} %`,
      `Load / DLR Fore   : ${fmt(d.load_dlrf_pct[i],1)} %`,
      `Margin to SLR     : ${fmt(d.margin_slr_pct[i],1)} %`,
      `Margin to DLR Calc: ${fmt(d.margin_dlr_pct[i],1)} %`,
      `─────────────────────────────`,
      `DLR Calc vs SLR   : ${fmt(d.dlrc_vs_slr_a[i],1)} A  (${fmt(d.dlrc_vs_slr_pct[i],1)} %)`,
      `DLR Sensor vs SLR : ${fmt(d.dlrs_vs_slr_a[i],1)} A  (${fmt(d.dlrs_vs_slr_pct[i],1)} %)`,
      `DLR Fore vs SLR   : ${fmt(d.dlrf_vs_slr_a[i],1)} A  (${fmt(d.dlrf_vs_slr_pct[i],1)} %)`,
      `─────────────────────────────`,
      `Risk Level        : <b style="color:${riskColor(d.risk[i])}">${d.risk[i]}</b>`,
    ].join('<br>');
  });

  // ── Traces ──────────────────────────────────────────────
  const traceLoad = {
    x: d.labels, y: d.load,
    name: 'Load Current',
    type: 'scatter', mode: 'lines',
    line: { color: '#2563eb', width: 2 },
    hoverinfo: 'text', hovertext: hoverText,
    hoverlabel: {
      bgcolor: '#0f172a', bordercolor: '#334155',
      font: { color: '#e2e8f0', size: 11, family: 'monospace' },
      align: 'left',
    },
  };

  const traceSLR = {
    x: [d.labels[0], d.labels[n-1]], y: [SLR_VAL, SLR_VAL],
    name: 'SLR = 1434 A',
    type: 'scatter', mode: 'lines',
    line: { color: '#dc2626', width: 2, dash: 'dash' },
    hoverinfo: 'skip',
  };

  // SLR percentage reference lines
  const slrPctLines = [90, 80, 70, 60].map(pct => ({
    x: [d.labels[0], d.labels[n-1]],
    y: [SLR_VAL * pct / 100, SLR_VAL * pct / 100],
    name: `${pct}% SLR (${(SLR_VAL * pct / 100).toFixed(0)} A)`,
    type: 'scatter', mode: 'lines',
    line: { color: '#94a3b8', width: 1, dash: 'dot' },
    hoverinfo: 'skip',
    showlegend: true,
  }));

  const traceDLRCalc = {
    x: d.labels, y: d.dlr_calc,
    name: 'DLR Calculated',
    type: 'scatter', mode: 'lines',
    line: { color: 'rgba(22,163,74,0.7)', width: 1.5 },
    hoverinfo: 'skip',
  };

  const traceDLRSensor = {
    x: d.labels, y: d.dlr_sensor,
    name: 'DLR Sensor',
    type: 'scatter', mode: 'lines',
    line: { color: 'rgba(234,88,12,0.65)', width: 1.5, dash: 'dot' },
    hoverinfo: 'skip',
  };

  const traceDLRForecast = {
    x: d.labels, y: d.dlr_forecast,
    name: 'DLR Forecast',
    type: 'scatter', mode: 'lines',
    line: { color: 'rgba(147,51,234,0.6)', width: 1.5, dash: 'dashdot' },
    hoverinfo: 'skip',
  };

  const layout = {
    paper_bgcolor: '#ffffff',
    plot_bgcolor:  '#f8fafc',
    margin: { t: 40, r: 30, b: 60, l: 65 },
    xaxis: {
      title: { text: 'Date / Time', font: { size: 12 } },
      showgrid: true, gridcolor: '#e2e8f0',
      rangeslider: { visible: true, thickness: 0.06 },
      type: 'category',
      nticks: n > 200 ? 12 : n > 30 ? 8 : n,
      tickangle: -30,
    },
    yaxis: {
      title: { text: 'Current / Ampacity (A)', font: { size: 12 } },
      showgrid: true, gridcolor: '#e2e8f0',
      rangemode: 'tozero',
      fixedrange: false,
    },
    legend: {
      orientation: 'h',
      x: 0, y: 1.06,
      font: { size: 11 },
      bgcolor: 'rgba(255,255,255,0.8)',
    },
    hovermode: 'closest',
    shapes: shapes,
    annotations: [
      { xref: 'paper', yref: 'y', x: 1.002, y: SLR_VAL,
        text: 'SLR = 1434 A', showarrow: false,
        font: { color: '#dc2626', size: 10 }, xanchor: 'left' },
      ...([90, 80, 70, 60].map(pct => ({
        xref: 'paper', yref: 'y', x: 1.002,
        y: SLR_VAL * pct / 100,
        text: `${pct}% SLR (${(SLR_VAL * pct / 100).toFixed(0)} A)`,
        showarrow: false, font: { color: '#94a3b8', size: 9 }, xanchor: 'left',
      }))),
    ],
  };

  const config = {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ['lasso2d','select2d'],
    displaylogo: false,
    scrollZoom: true,
  };

  // ── Highlight traces (empty by default, filled by toggleHighlight) ────
  const traceHighlight = buildHighlightTrace(d, _activeHighlight);

  Plotly.react('risk-plotly-chart',
    [traceLoad, traceSLR, ...slrPctLines, traceDLRCalc, traceDLRSensor, traceDLRForecast,
     traceHighlight],
    layout, config
  );
}

// Build a scatter-marker trace that overlays red boxes on Load Current
// for points matching the given risk level(s)
function buildHighlightTrace(d, level) {
  // Which risk levels to highlight for each button
  const LEVEL_MAP = {
    'Caution':    ['Caution'],
    'Risky':      ['Risky'],
    'Very Risky': ['Very Risky'],
    'All Risk':   ['Caution', 'Risky', 'Very Risky'],
  };
  const targets = level ? (LEVEL_MAP[level] || []) : [];

  const hx = [], hy = [], hcolors = [], hsymbols = [];
  const MARKER_COLOUR = {
    'Caution':    'rgba(234,179,8,0.9)',
    'Risky':      'rgba(234,88,12,0.95)',
    'Very Risky': 'rgba(220,38,38,1.0)',
  };

  d.labels.forEach((lbl, i) => {
    if (targets.includes(d.risk[i]) && d.load[i] != null) {
      hx.push(lbl);
      hy.push(d.load[i]);
      hcolors.push(MARKER_COLOUR[d.risk[i]] || '#dc2626');
      hsymbols.push('square-open');
    }
  });

  return {
    x: hx, y: hy,
    name: level ? `⚠ ${level} points` : '_highlight_empty',
    type: 'scatter',
    mode: 'markers',
    marker: {
      symbol: hsymbols,
      size: 12,
      color: hcolors,
      line: { color: hcolors, width: 2.5 },
    },
    hoverinfo: 'skip',
    showlegend: hx.length > 0,
  };
}

// Called by clicking risk badge buttons
function toggleHighlight(level) {
  // Toggle off if same button clicked again
  _activeHighlight = (_activeHighlight === level) ? null : level;

  // Update badge button visual states
  document.querySelectorAll('.rdot').forEach(el => el.classList.remove('hl-active'));
  if (_activeHighlight) {
    const map = {
      'Caution': 'caution', 'Risky': 'risky',
      'Very Risky': 'very-risky', 'All Risk': 'risky',
    };
    const cls = map[_activeHighlight];
    if (cls) document.querySelector('.rdot.' + cls)?.classList.add('hl-active');
  }

  if (!_riskChartData) return;

  // Re-draw only the highlight trace (trace index = last = 6 + 4 slr lines = index 10)
  const traceHighlight = buildHighlightTrace(_riskChartData, _activeHighlight);
  // Use Plotly.deleteTraces + addTraces to replace the last trace cleanly
  const el = document.getElementById('risk-plotly-chart');
  const currentCount = el.data ? el.data.length : 0;
  if (currentCount > 0) {
    Plotly.deleteTraces('risk-plotly-chart', currentCount - 1);
  }
  Plotly.addTraces('risk-plotly-chart', traceHighlight);
}

function riskColor(r) {
  const m = { 'Safe':'#16a34a','Caution':'#d97706','Risky':'#ea580c','Very Risky':'#dc2626' };
  return m[r] || '#64748b';
}

// ═══════════════════════════════════════════════════════════
// WIND VELOCITY & DIRECTION ANALYSIS — Polar Scatter (Plotly)
// ═══════════════════════════════════════════════════════════

// Colour maps
const RISK_COLOUR_MAP = {
  'Safe':       '#16a34a',
  'Caution':    '#d97706',
  'Risky':      '#ea580c',
  'Very Risky': '#dc2626',
};

function windRiskColour(risk) {
  return RISK_COLOUR_MAP[risk] || '#64748b';
}

// Build DLR-based continuous colour (blue-low → green-high)
function dlrToColour(val, minV, maxV) {
  const t = Math.max(0, Math.min(1, (val - minV) / (maxV - minV)));
  // Interpolate: low = #dc2626 (red) → mid = #f59e0b (amber) → high = #16a34a (green)
  if (t < 0.5) {
    const u = t * 2;
    const r = Math.round(220 + (245 - 220) * u);
    const g = Math.round(38  + (158 - 38)  * u);
    const b = Math.round(38  + (11  - 38)  * u);
    return `rgb(${r},${g},${b})`;
  } else {
    const u = (t - 0.5) * 2;
    const r = Math.round(245 + (22  - 245) * u);
    const g = Math.round(158 + (163 - 158) * u);
    const b = Math.round(11  + (74  - 11)  * u);
    return `rgb(${r},${g},${b})`;
  }
}

async function loadWindAnalysis() {
  const month     = parseInt(document.getElementById('wind-month-sel').value) || 0;
  const colourBy  = document.getElementById('wind-colour-sel').value;
  const url       = `/api/wind_analysis?month=${month}&mode=all`;
  const d         = await fetchJSON(url);

  if (!d || !d.wind_speed || d.wind_speed.length === 0) {
    document.getElementById('wind-polar-chart').innerHTML =
      '<p style="padding:2rem;color:#94a3b8;text-align:center">No wind data available for this selection.</p>';
    return;
  }

  const n = d.wind_speed.length;

  // ── Colour arrays ──────────────────────────────────────
  const dlrVals = d.dlr_calc.filter(Boolean);
  const minDlr  = Math.min(...dlrVals);
  const maxDlr  = Math.max(...dlrVals);

  const markerColours = d.wind_speed.map((_, i) => {
    if (colourBy === 'risk') {
      return windRiskColour(d.risk[i]);
    } else {
      return d.dlr_calc[i] != null ? dlrToColour(d.dlr_calc[i], minDlr, maxDlr) : '#94a3b8';
    }
  });

  // ── Hover text ─────────────────────────────────────────
  function fv(v, dp=1) { return v == null ? '—' : (+v).toFixed(dp); }
  function toCard(deg) {
    if (deg == null) return '—';
    const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
    return dirs[Math.round(deg / 22.5) % 16];
  }

  const hoverText = d.wind_speed.map((_, i) => [
    `<b>${d.datetime[i]}</b>`,
    `─────────────────────────`,
    `Wind Speed     : <b>${fv(d.wind_speed[i], 2)} m/s</b>`,
    `Wind Direction : <b>${fv(d.wind_dir[i], 0)}° (${toCard(d.wind_dir[i])})</b>`,
    `─────────────────────────`,
    `DLR Calculated : ${fv(d.dlr_calc[i], 1)} A`,
    `DLR Sensor     : ${fv(d.dlr_sensor[i], 1)} A`,
    `DLR Forecast   : ${fv(d.dlr_fore[i], 1)} A`,
    `─────────────────────────`,
    `Ambient Temp   : ${fv(d.ta[i], 1)} °C`,
    `Conductor Temp : ${fv(d.ts[i], 1)} °C`,
    `Load Current   : ${fv(d.load[i], 1)} A`,
    `Risk Level     : <b style="color:${windRiskColour(d.risk[i])}">${d.risk[i]}</b>`,
  ].join('<br>'));

  // ── Plotly polar scatter trace ─────────────────────────
  const trace = {
    type: 'scatterpolar',
    mode: 'markers',
    r:      d.wind_speed,
    theta:  d.wind_dir,
    text:   hoverText,
    hoverinfo: 'text',
    hoverlabel: {
      bgcolor: '#0f172a', bordercolor: '#334155',
      font: { color: '#e2e8f0', size: 11, family: 'monospace' },
      align: 'left',
    },
    marker: {
      color: markerColours,
      size: 6,
      opacity: 0.75,
      line: { color: 'rgba(255,255,255,0.3)', width: 0.5 },
    },
  };

  // Cardinal direction tick labels
  const angularTicks = {
    tickvals: [0,45,90,135,180,225,270,315],
    ticktext: ['N (0°)','NE (45°)','E (90°)','SE (135°)',
               'S (180°)','SW (225°)','W (270°)','NW (315°)'],
  };

  const monthNames = ['Full Year','Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];

  const layout = {
    autosize: true,
    paper_bgcolor: '#ffffff',
    polar: {
      bgcolor: '#f8fafc',
      radialaxis: {
        visible: true,
        title: { text: 'Wind Speed (m/s)', font: { size: 11 } },
        tickfont: { size: 10 },
        gridcolor: '#e2e8f0',
        linecolor: '#cbd5e1',
        range: [0, Math.ceil((Math.max(...d.wind_speed.filter(Boolean)) || 6) * 1.1)],
      },
      angularaxis: {
        tickfont: { size: 10 },
        gridcolor: '#e2e8f0',
        linecolor: '#cbd5e1',
        direction: 'clockwise',
        rotation: 90,   // 0° points North
        ...angularTicks,
      },
    },
    title: {
      text: `Wind Velocity & Direction — ${monthNames[month] || 'Full Year'} 2021`
            + `<br><sup style="color:#64748b">n = ${n} observations | coloured by ${colourBy === 'risk' ? 'Risk Level' : 'DLR Calculated (A)'}</sup>`,
      font: { size: 13, color: '#1e293b' },
      x: 0.5,
    },
    margin: { t: 80, r: 30, b: 30, l: 30 },
    showlegend: false,
  };

  Plotly.react('wind-polar-chart', [trace], layout, {
    responsive: true,
    displayModeBar: true,
    modeBarButtonsToRemove: ['lasso2d', 'select2d'],
    displaylogo: false,
    scrollZoom: false,
  });

  // ── Update inline legend ───────────────────────────────
  updateWindLegend(colourBy, minDlr, maxDlr, d);

  // ── Update stats ───────────────────────────────────────
  const validWS  = d.wind_speed.filter(Boolean);
  const validDlr = d.dlr_calc.filter(Boolean);
  document.getElementById('wind-stats').innerHTML = `
    <div class="wstat">
      <div class="wstat-label">Mean Wind</div>
      <div class="wstat-value">${(validWS.reduce((a,b)=>a+b,0)/validWS.length).toFixed(2)} m/s</div>
    </div>
    <div class="wstat">
      <div class="wstat-label">Max Wind</div>
      <div class="wstat-value">${Math.max(...validWS).toFixed(2)} m/s</div>
    </div>
    <div class="wstat">
      <div class="wstat-label">Mean DLR</div>
      <div class="wstat-value">${(validDlr.reduce((a,b)=>a+b,0)/validDlr.length).toFixed(0)} A</div>
    </div>
    <div class="wstat">
      <div class="wstat-label">n Points</div>
      <div class="wstat-value">${n.toLocaleString()}</div>
    </div>`;
}

function updateWindLegend(colourBy, minDlr, maxDlr, d) {
  const box = document.getElementById('wind-legend-box');
  if (!box) return;

  if (colourBy === 'risk') {
    box.innerHTML = Object.entries(RISK_COLOUR_MAP).map(([label, colour]) =>
      `<div class="wleg-item">
         <span class="wleg-dot" style="background:${colour}"></span>
         <span>${label}</span>
       </div>`
    ).join('');
  } else {
    // DLR gradient legend: show low / mid / high
    const mid = ((minDlr + maxDlr) / 2).toFixed(0);
    box.innerHTML = [
      [dlrToColour(minDlr, minDlr, maxDlr), `Low DLR (≈${minDlr.toFixed(0)} A)`],
      [dlrToColour((minDlr+maxDlr)/2, minDlr, maxDlr), `Mid DLR (≈${mid} A)`],
      [dlrToColour(maxDlr, minDlr, maxDlr), `High DLR (≈${maxDlr.toFixed(0)} A)`],
    ].map(([colour, label]) =>
      `<div class="wleg-item">
         <span class="wleg-dot" style="background:${colour}"></span>
         <span>${label}</span>
       </div>`
    ).join('');
  }
}

// Auto-reload when selectors change
document.getElementById('wind-month-sel').addEventListener('change', loadWindAnalysis);
document.getElementById('wind-colour-sel').addEventListener('change', loadWindAnalysis);

// ═══════════════════════════════════════════════════════════
// STUDY LOCATION MAP  —  Leaflet.js
// Coordinates: Ayer Tawar–Pantai Remis 275 kV, Manjung, Perak
// ═══════════════════════════════════════════════════════════

const STUDY_LAT = 4.3962;
const STUDY_LNG = 100.7096;

function initStudyMap() {
  // Guard: Leaflet must be loaded (it is deferred so will be ready by tab click)
  if (typeof L === 'undefined') {
    console.error('Leaflet not loaded yet');
    return;
  }
  // Guard: don't double-init
  if (window._leafletMap) {
    window._leafletMap.invalidateSize();
    return;
  }

  // ── Initialise map centred on Perak ───────────────────────────────────────
  const map = L.map('study-map', {
    center: [4.6, 101.0],   // centred on Perak state
    zoom: 9,
    zoomControl: true,
    scrollWheelZoom: false,
  });
  window._leafletMap = map;

  // ── OpenStreetMap tile layer ──────────────────────────────────────────────
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 18,
  }).addTo(map);

  // ── Custom SVG marker pin (matches dashboard blue) ────────────────────────
  const markerSVG = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44">
      <path d="M16 0 C7.16 0 0 7.16 0 16 C0 28 16 44 16 44 C16 44 32 28 32 16 C32 7.16 24.84 0 16 0 Z"
            fill="#2563eb" stroke="#1d4ed8" stroke-width="1.5"/>
      <circle cx="16" cy="16" r="7" fill="#fff"/>
      <text x="16" y="20" text-anchor="middle" font-size="11" font-weight="bold"
            fill="#2563eb" font-family="Arial">⚡</text>
    </svg>`;

  const pinIcon = L.divIcon({
    html: markerSVG,
    iconSize:   [32, 44],
    iconAnchor: [16, 44],
    popupAnchor:[0, -44],
    className:  '',
  });

  // ── Marker with rich popup ────────────────────────────────────────────────
  const popup = L.popup({ maxWidth: 280, className: 'study-popup' }).setContent(`
    <div style="font-family:'Segoe UI',Arial,sans-serif;font-size:13px;line-height:1.6">
      <div style="font-weight:700;font-size:14px;color:#1e293b;margin-bottom:6px">
        ⚡ Ayer Tawar – Pantai Remis 275 kV Line
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <tr><td style="color:#64748b;padding:2px 6px 2px 0;width:45%">Location</td>
            <td style="font-weight:600;color:#1e293b">Manjung, Perak</td></tr>
        <tr><td style="color:#64748b;padding:2px 6px 2px 0">Country</td>
            <td style="font-weight:600;color:#1e293b">Malaysia</td></tr>
        <tr><td style="color:#64748b;padding:2px 6px 2px 0">Coordinates</td>
            <td style="font-weight:600;color:#1e293b">4.3962° N, 100.7096° E</td></tr>
        <tr><td style="color:#64748b;padding:2px 6px 2px 0">Voltage</td>
            <td style="font-weight:600;color:#1e293b">275 kV</td></tr>
        <tr><td style="color:#64748b;padding:2px 6px 2px 0">Authority</td>
            <td style="font-weight:600;color:#1e293b">TNB Malaysia</td></tr>
      </table>
      <div style="margin-top:8px;padding:6px 8px;background:#fef2f2;border-left:3px solid #dc2626;
                  border-radius:0 4px 4px 0;font-size:11px;color:#991b1b">
        ⚠ Risk of 7 m ground clearance violation due to conductor sag at T<sub>max</sub> = 75°C
      </div>
    </div>`);

  L.marker([STUDY_LAT, STUDY_LNG], { icon: pinIcon })
    .addTo(map)
    .bindPopup(popup)
    .openPopup();

  // ── Dashed circle showing ~5 km study area radius ─────────────────────────
  L.circle([STUDY_LAT, STUDY_LNG], {
    radius: 5000,           // 5 km
    color: '#2563eb',
    weight: 1.5,
    dashArray: '6 4',
    fillColor: '#2563eb',
    fillOpacity: 0.06,
  }).addTo(map);

  // ── Text label next to marker ─────────────────────────────────────────────
  L.marker([STUDY_LAT + 0.06, STUDY_LNG + 0.12], {
    icon: L.divIcon({
      html: `<div style="
        background:rgba(255,255,255,0.92);
        border:1px solid #2563eb;
        border-radius:5px;
        padding:3px 7px;
        font-size:11px;
        font-weight:600;
        color:#1e293b;
        white-space:nowrap;
        box-shadow:0 1px 4px rgba(0,0,0,0.15);
        font-family:'Segoe UI',Arial,sans-serif">
        275 kV Line<br>
        <span style="font-weight:400;color:#64748b">Manjung, Perak</span>
      </div>`,
      className: '',
      iconAnchor: [0, 0],
    }),
  }).addTo(map);

  // Force Leaflet to recalculate size after tab becomes visible
  setTimeout(() => map.invalidateSize(), 150);
}
