/* ═══════════════════════════════════════════════════════════
   Llama.cpp Monitor — Dashboard JavaScript
   ═══════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────
let currentRange = "24h";
let tokensChart = null;
let throughputChart = null;
let refreshTimer = null;

// Gruvbox palette for chart datasets
const COLORS = [
  "#98971a", // green
  "#458588", // blue
  "#d65d0e", // orange
  "#b16286", // purple
  "#689d6a", // aqua
  "#d79921", // yellow
  "#cc241d", // red
  "#fabd2f", // yellow-b
];

// ── Helpers ────────────────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return Number(n).toLocaleString();
}

function fmtNum(n) {
  if (n == null || isNaN(n)) return "—";
  return Number(n).toLocaleString();
}

function fmtTime(sec) {
  if (sec == null || isNaN(sec) || sec === 0) return "—";
  if (sec >= 3600) return (sec / 3600).toFixed(1) + "h";
  if (sec >= 60) return (sec / 60).toFixed(1) + "m";
  return sec.toFixed(1) + "s";
}

function fmtTimestamp(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
}

// ── API Calls ──────────────────────────────────────────────

async function api(path) {
  try {
    const r = await fetch(path);
    return await r.json();
  } catch (e) {
    console.error("API error:", e);
    return null;
  }
}

// ── Render Functions ───────────────────────────────────────

async function renderCurrentState() {
  const data = await api("/api/current");
  if (!data) return;

  const grid = document.getElementById("instance-grid");
  grid.innerHTML = "";

  data.instances.forEach(inst => {
    const card = document.createElement("div");
    card.className = "instance-card";

    const statusClass = inst.status === "loaded" ? "status-loaded"
      : inst.status === "loading" ? "status-loading"
      : "status-unloaded";

    card.innerHTML = `
      <div class="instance-info">
        <span class="instance-name">${inst.instance}</span>
        <span class="instance-model">${inst.model}</span>
      </div>
      <span class="instance-status ${statusClass}">${inst.status}</span>
    `;
    grid.appendChild(card);
  });
}

async function renderTotals() {
  const data = await api("/api/summary");
  if (!data || !data.totals.length) return;

  let totalPrompt = 0, totalPredicted = 0;
  let totalPredictedTps = 0;
  let throughputCount = 0;

  data.totals.forEach(t => {
    totalPrompt += t.prompt_tokens || 0;
    totalPredicted += t.predicted_tokens || 0;
    if (t.predicted_tokens_per_sec > 0) {
      totalPredictedTps += t.predicted_tokens_per_sec;
      throughputCount++;
    }
  });

  document.getElementById("total-prompt").textContent = fmt(totalPrompt);
  document.getElementById("total-predicted").textContent = fmt(totalPredicted);
  document.getElementById("total-all").textContent = fmt(totalPrompt + totalPredicted);

  const avgTps = throughputCount > 0 ? (totalPredictedTps / throughputCount) : 0;
  document.getElementById("avg-throughput").textContent = avgTps.toFixed(1);

  // Sub labels with time range
  const rangeLabel = currentRange === "all" ? "all time"
    : `last ${currentRange}`;
  document.getElementById("total-prompt-sub").textContent = rangeLabel;
  document.getElementById("total-predicted-sub").textContent = rangeLabel;
}

async function renderModelTable() {
  const data = await api("/api/summary");
  if (!data || !data.totals.length) return;

  const tbody = document.getElementById("model-tbody");
  tbody.innerHTML = "";

  data.totals.forEach(t => {
    const total = (t.prompt_tokens || 0) + (t.predicted_tokens || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="instance-cell">${t.instance}</td>
      <td class="model-name-cell">${t.model}</td>
      <td class="num">${fmtNum(t.prompt_tokens)}</td>
      <td class="num">${fmtNum(t.predicted_tokens)}</td>
      <td class="num accent-yellow">${fmtNum(total)}</td>
      <td class="num">${t.prompt_tokens_per_sec}</td>
      <td class="num">${t.predicted_tokens_per_sec}</td>
      <td class="num">${fmtTime(t.prompt_time_sec)}</td>
      <td class="num">${fmtTime(t.predict_time_sec)}</td>
      <td class="num">${fmtNum(t.decodes)}</td>
      <td><span class="badge ${t.requests_processing > 0 ? 'badge-live' : 'badge-offline'}">${t.requests_processing > 0 ? 'active' : 'idle'}</span></td>
    `;
    tbody.appendChild(tr);
  });

  document.getElementById("instance-count").textContent = new Set(data.totals.map(t => t.instance)).size;
}

async function renderDistributionBars() {
  const data = await api("/api/summary");
  if (!data || !data.totals.length) return;

  const container = document.getElementById("dist-bars");
  container.innerHTML = "";

  // Aggregate by model across instances
  const modelMap = {};
  data.totals.forEach(t => {
    const key = t.model;
    if (!modelMap[key]) modelMap[key] = { prompt: 0, predicted: 0, instances: new Set() };
    modelMap[key].prompt += t.prompt_tokens || 0;
    modelMap[key].predicted += t.predicted_tokens || 0;
    modelMap[key].instances.add(t.instance);
  });

  const entries = Object.entries(modelMap).map(([model, v]) => ({
    model,
    total: v.prompt + v.predicted,
    prompt: v.prompt,
    predicted: v.predicted,
  })).sort((a, b) => b.total - a.total);

  const maxTotal = Math.max(...entries.map(e => e.total), 1);

  entries.forEach((e, i) => {
    const pct = (e.total / maxTotal) * 100;
    const color = COLORS[i % COLORS.length];

    const row = document.createElement("div");
    row.className = "dist-row";
    row.innerHTML = `
      <span class="dist-label" title="${e.model}">${e.model}</span>
      <div class="dist-bar-bg">
        <div class="dist-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="dist-value">${fmt(e.total)}</span>
    `;
    container.appendChild(row);
  });
}

// ── Charts ─────────────────────────────────────────────────

function makeChartOptions(title) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
      legend: {
        labels: {
          color: "#a89984",
          font: { family: "'JetBrains Mono', monospace", size: 11 },
          boxWidth: 12,
          padding: 12,
        }
      },
      tooltip: {
        backgroundColor: "#282828",
        titleColor: "#ebdbb2",
        bodyColor: "#d5c4a1",
        borderColor: "#504945",
        borderWidth: 1,
        titleFont: { family: "'JetBrains Mono', monospace" },
        bodyFont: { family: "'JetBrains Mono', monospace" },
        padding: 10,
        callbacks: {
          title: function(items) {
            if (!items.length) return "";
            const d = new Date(items[0].parsed.x * 1000);
            return d.toLocaleTimeString();
          }
        }
      }
    },
    scales: {
      x: {
        type: "category",
        grid: { color: "#3c3836" },
        ticks: {
          color: "#928374",
          font: { size: 10, family: "'JetBrains Mono', monospace" },
          maxRotation: 45,
          autoSkip: true,
          maxTicksLimit: 12,
          callback: function(val, idx) {
            const d = new Date(this.getLabelForValue(val) * 1000);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        }
      },
      y: {
        beginAtZero: true,
        grid: { color: "#3c3836" },
        ticks: {
          color: "#928374",
          font: { size: 10, family: "'JetBrains Mono', monospace" },
          callback: v => fmt(v),
        }
      }
    },
    interaction: {
      intersect: false,
      mode: "index",
    }
  };
}

function buildDatasets(points, valueKey1, valueKey2, labelPrefix) {
  // Aggregate by instance+model, group points by time
  const seriesMap = {};

  points.forEach(p => {
    const key = `${p.instance}/${p.model}`;
    if (!seriesMap[key]) {
      seriesMap[key] = { label: key, data: [], color: null };
    }
    seriesMap[key].data.push({ x: p.ts, y1: p.v1, y2: p.v2 });
  });

  // Assign colors
  Object.keys(seriesMap).forEach((k, i) => {
    seriesMap[k].color = COLORS[i % COLORS.length];
  });

  return Object.values(seriesMap).map(s => ({
    label: s.label,
    borderColor: s.color,
    backgroundColor: s.color + "22",
    borderWidth: 2,
    fill: false,
    tension: 0.3,
    pointRadius: 0,
    pointHoverRadius: 4,
    data: s.data.map(d => ({ x: d.x, y: d[labelPrefix === "tokens" ? "y1" : "y2"] })),
  }));
}

async function renderCharts() {
  // Tokens chart
  const tokensData = await api(`/api/series?range=${currentRange}&metric=tokens`);
  if (tokensData && tokensChart) {
    const datasets = buildDatasets(tokensData.points, "v1", "v2", "tokens");
    tokensChart.data.datasets = datasets;
    tokensChart.update();
  }

  // Throughput chart
  const tpData = await api(`/api/series?range=${currentRange}&metric=throughput`);
  if (tpData && throughputChart) {
    const datasets = buildDatasets(tpData.points, "v1", "v2", "throughput");
    throughputChart.data.datasets = datasets;
    throughputChart.update();
  }
}

function initCharts() {
  const chartOpts = makeChartOptions();

  tokensChart = new Chart(document.getElementById("tokens-chart"), {
    type: "line",
    data: { datasets: [] },
    options: chartOpts,
  });

  throughputChart = new Chart(document.getElementById("throughput-chart"), {
    type: "line",
    data: { datasets: [] },
    options: {
      ...chartOpts,
      scales: {
        ...chartOpts.scales,
        y: {
          ...chartOpts.scales.y,
          ticks: {
            ...chartOpts.scales.y.ticks,
            callback: v => v.toFixed(1) + " t/s",
          }
        }
      }
    },
  });
}

// ── Cost Comparison ────────────────────────────────────────────────

let openrouterModels = [];
let costSearchDebounce = null;
let selectedCostModel = null;

async function loadOpenRouterModels(query = "") {
  try {
    const url = query
      ? `/api/openrouter-models?q=${encodeURIComponent(query)}`
      : "/api/openrouter-models";
    const data = await api(url);
    if (data) {
      openrouterModels = data.models || [];
      renderCostDropdown(openrouterModels);
    }
  } catch (e) {
    console.error("Failed to load OpenRouter models:", e);
  }
}

function renderCostDropdown(models) {
  const dropdown = document.getElementById("cost-dropdown");
  if (!dropdown) return;

  if (!models.length) {
    dropdown.innerHTML = '<div class="cost-dropdown-empty">No models found</div>';
    dropdown.classList.add("open");
    return;
  }

  // Show max 50 results to avoid DOM bloat
  const shown = models.slice(0, 50);
  const fmtPrice = (p) => p != null ? `$${(parseFloat(p) * 1000000).toFixed(2)}/M` : "—";
  dropdown.innerHTML = shown.map(m => {
    const pp = fmtPrice(m.prompt_price);
    const cp = fmtPrice(m.completion_price);
    return `<div class="cost-dropdown-item" data-id="${m.id}">
      <span class="model-name" title="${m.id}">${m.name || m.id}</span>
      <span class="model-pricing">in: <span>${pp}</span> · out: <span>${cp}</span></span>
    </div>`;
  }).join("");

  if (models.length > 50) {
    dropdown.innerHTML += `<div class="cost-dropdown-empty">…and ${models.length - 50} more (type to narrow)</div>`;
  }

  // Click handlers
  dropdown.querySelectorAll(".cost-dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = item.dataset.id;
      selectedCostModel = id;
      document.getElementById("cost-search").value = id;
      dropdown.classList.remove("open");
      calculateCost(id);
    });
  });

  dropdown.classList.add("open");
}

async function calculateCost(modelId) {
  const resultEl = document.getElementById("cost-result");
  if (!resultEl) return;

  resultEl.innerHTML = '<div class="cost-placeholder">Calculating…</div>';

  try {
    const data = await api(`/api/cost-calc?model=${encodeURIComponent(modelId)}&range=${currentRange}`);
    if (!data || data.error) {
      resultEl.innerHTML = `<div class="cost-placeholder">${data?.error || "Error calculating cost"}</div>`;
      return;
    }

    const rangeLabel = currentRange === "all" ? "all time" : `last ${currentRange}`;
    resultEl.innerHTML = `
      <div class="cost-result-card">
        <div class="cost-result-header">
          <span class="cost-result-model">${data.model_name}</span>
          <span class="cost-result-range">${rangeLabel}</span>
        </div>
        <div class="cost-result-body">
          <div class="cost-stat">
            <div class="cost-stat-label">Prompt Tokens</div>
            <div class="cost-stat-value accent-green">${fmt(data.prompt_tokens)}</div>
          </div>
          <div class="cost-stat">
            <div class="cost-stat-label">Completion Tokens</div>
            <div class="cost-stat-value accent-blue">${fmt(data.completion_tokens)}</div>
          </div>
          <div class="cost-stat">
            <div class="cost-stat-label">Total Tokens</div>
            <div class="cost-stat-value accent-yellow">${fmt(data.total_tokens)}</div>
          </div>
        </div>
        <div class="cost-result-footer">
          <div class="cost-total-label">Estimated Cost</div>
          <div class="cost-total-value">${data.cost_formatted}</div>
        </div>
      </div>
    `;
  } catch (e) {
    resultEl.innerHTML = '<div class="cost-placeholder">Failed to calculate cost</div>';
    console.error("Cost calculation error:", e);
  }
}

// Initialize cost comparison search
function initCostComparison() {
  const input = document.getElementById("cost-search");
  const dropdown = document.getElementById("cost-dropdown");
  if (!input || !dropdown) return;

  // Load models on focus or input
  input.addEventListener("focus", () => {
    if (!input.value) {
      loadOpenRouterModels();
    }
  });

  input.addEventListener("input", () => {
    clearTimeout(costSearchDebounce);
    costSearchDebounce = setTimeout(() => {
      loadOpenRouterModels(input.value);
    }, 250);
  });

  // Close dropdown on outside click
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".cost-input-row")) {
      dropdown.classList.remove("open");
    }
  });

  // Recalculate when time range changes
  const origRefresh = window.refresh;
  window.refresh = async function () {
    await origRefresh();
    if (selectedCostModel) {
      calculateCost(selectedCostModel);
    }
  };
}

// ── Main ───────────────────────────────────────────────────

async function refresh() {
  const start = performance.now();

  await Promise.all([
    renderCurrentState(),
    renderTotals(),
    renderModelTable(),
    renderDistributionBars(),
    renderCharts(),
  ]);

  const elapsed = Math.round(performance.now() - start);
  document.getElementById("last-update").textContent =
    `updated ${fmtTimestamp(Date.now() / 1000)} (${elapsed}ms)`;
}

// Time range buttons
document.querySelectorAll(".range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelector(".range-btn.active")?.classList.remove("active");
    btn.classList.add("active");
    currentRange = btn.dataset.range;
    refresh();
  });
});

// Init
initCharts();
initCostComparison();
refresh();

// Auto-refresh every 15s
refreshTimer = setInterval(refresh, 15000);