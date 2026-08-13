/* ═══════════════════════════════════════════════════════════
   Llama.cpp Monitor — Dashboard JavaScript
   ═══════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────
let currentRange = "24h";
let refreshTimer = null;
let filterInstance = "";
let filterModel = "";

// Energy settings
let energyWattsMap = {};  // { "llama-1": 400, "llama-2": 150 }
let energyRate = 0.12;

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

function fmtKwh(kwh) {
  if (kwh == null || isNaN(kwh) || kwh === 0) return "—";
  if (kwh < 0.001) return (kwh * 1000).toFixed(1) + " Wh";
  return kwh.toFixed(4) + " kWh";
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

// ── Settings Modal ─────────────────────────────────────────

async function initSettings() {
  const modal = document.getElementById("settings-modal");
  const btn = document.getElementById("settings-btn");
  const close = document.getElementById("settings-close");
  const saveBtn = document.getElementById("settings-save");
  const rateInput = document.getElementById("setting-rate");
  const themeSelect = document.getElementById("theme-select");
  const wattsContainer = document.getElementById("watts-inputs");

  // Load saved settings from server
  const settings = await api("/api/settings");

  // Restore saved wattage map (server-side)
  if (settings && settings.energy_watts) {
    energyWattsMap = settings.energy_watts;
  }
  if (settings && settings.energy_rate != null) {
    energyRate = settings.energy_rate;
    rateInput.value = energyRate;
  }

  // Build per-instance wattage inputs
  const instData = await api("/api/instances");
  if (instData) {
    wattsContainer.innerHTML = instData.instances.map(inst => {
      const w = energyWattsMap[inst] || "";
      return `<div class="watts-input-row">
        <label for="watt-${inst}">${inst}</label>
        <input type="number" id="watt-${inst}" data-instance="${inst}"
               min="0" step="1" value="${w}" placeholder="W">
      </div>`;
    }).join("");
  }

  // Open/close
  btn.addEventListener("click", () => modal.classList.add("open"));
  close.addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("open");
  });

  // Save button — persist to server
  saveBtn.addEventListener("click", () => {
    // Collect wattage from inputs
    wattsContainer.querySelectorAll("input").forEach(input => {
      const inst = input.dataset.instance;
      const val = parseFloat(input.value) || 0;
      energyWattsMap[inst] = val;
    });

    // Collect rate
    energyRate = parseFloat(rateInput.value) || 0;

    // Persist to server
    fetch("/api/settings", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        energy_watts: energyWattsMap,
        energy_rate: energyRate,
      }),
    });

    // Visual feedback
    saveBtn.textContent = "✓ Saved";
    saveBtn.classList.add("saved");

    // Close modal after short delay
    setTimeout(() => {
      modal.classList.remove("open");
      // Reset button after close
      setTimeout(() => {
        saveBtn.textContent = "Save";
        saveBtn.classList.remove("saved");
      }, 400);
    }, 600);

    // Trigger dashboard recalculation
    refresh();
  });

  // Theme change in settings
  themeSelect.addEventListener("change", (e) => {
    setTheme(e.target.value);
  });
}

// ── Filters ────────────────────────────────────────────────

function initFilters() {
  const instanceSelect = document.getElementById("filter-instance");
  const modelSelect = document.getElementById("filter-model");

  // Load available instances and models
  loadFilterOptions();

  instanceSelect.addEventListener("change", () => {
    filterInstance = instanceSelect.value;
    refresh();
  });

  modelSelect.addEventListener("change", () => {
    filterModel = modelSelect.value;
    refresh();
  });
}

async function loadFilterOptions() {
  const [instData, modelData] = await Promise.all([
    api("/api/instances"),
    api("/api/models"),
  ]);

  const instanceSelect = document.getElementById("filter-instance");
  const modelSelect = document.getElementById("filter-model");

  if (instData) {
    instanceSelect.innerHTML = '<option value="">All Instances</option>' +
      instData.instances.map(i => `<option value="${i}">${i}</option>`).join("");
  }

  if (modelData) {
    modelSelect.innerHTML = '<option value="">All Models</option>' +
      modelData.models.map(m => `<option value="${m}">${m}</option>`).join("");
  }
}

// ── Render Functions ───────────────────────────────────────

// Instance color map — stable color per instance label (shared with energy section)
const INSTANCE_PALETTE = ['#cc241d', '#458588', '#b16286', '#d65d0e', '#8ec07c', '#fabd2f'];
const instanceColorMap = {};
let instanceColorIdx = 0;

function getInstanceColor(instance) {
  if (!(instance in instanceColorMap)) {
    instanceColorMap[instance] = INSTANCE_PALETTE[instanceColorIdx++ % INSTANCE_PALETTE.length];
  }
  return instanceColorMap[instance];
}

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

    const color = getInstanceColor(inst.instance);

    card.innerHTML = `
      <div class="instance-info">
        <span class="instance-name"><span class="instance-dot" style="background:${color}"></span>${inst.instance}</span>
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

  // Apply filters
  let totals = data.totals;
  if (filterInstance) totals = totals.filter(t => t.instance === filterInstance);
  if (filterModel) totals = totals.filter(t => t.model === filterModel);

  let totalPrompt = 0, totalPredicted = 0;
  let totalPredictedTps = 0;
  let throughputCount = 0;

  totals.forEach(t => {
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
  const filterLabel = filterInstance || filterModel
    ? ` · ${filterInstance}${filterInstance && filterModel ? ' / ' : ''}${filterModel}`
    : '';
  document.getElementById("total-prompt-sub").textContent = rangeLabel + filterLabel;
  document.getElementById("total-predicted-sub").textContent = rangeLabel + filterLabel;
}

async function renderModelTable() {
  const data = await api("/api/summary");
  if (!data || !data.totals.length) return;

  const tbody = document.getElementById("model-tbody");
  tbody.innerHTML = "";

  // Apply filters
  let totals = data.totals;
  if (filterInstance) totals = totals.filter(t => t.instance === filterInstance);
  if (filterModel) totals = totals.filter(t => t.model === filterModel);

  // Sort by total tokens descending (most used first)
  totals.sort((a, b) => {
    const totalA = (a.prompt_tokens || 0) + (a.predicted_tokens || 0);
    const totalB = (b.prompt_tokens || 0) + (b.predicted_tokens || 0);
    return totalB - totalA;
  });

  totals.forEach(t => {
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

  document.getElementById("instance-count").textContent = new Set(totals.map(t => t.instance)).size;
}

let distPieChart = null;

async function renderDistributionBars() {
  const data = await api("/api/summary");
  if (!data || !data.totals.length) return;

  // Apply filters
  let totals = data.totals;
  if (filterInstance) totals = totals.filter(t => t.instance === filterInstance);
  if (filterModel) totals = totals.filter(t => t.model === filterModel);

  // Aggregate by model across instances
  const modelMap = {};
  totals.forEach(t => {
    const key = t.model;
    if (!modelMap[key]) modelMap[key] = { prompt: 0, predicted: 0, instances: new Set() };
    modelMap[key].prompt += t.prompt_tokens || 0;
    modelMap[key].predicted += t.predicted || 0;
    modelMap[key].instances.add(t.instance);
  });

  const entries = Object.entries(modelMap).map(([model, v]) => ({
    model,
    total: v.prompt + v.predicted,
    prompt: v.prompt,
    predicted: v.predicted,
  })).sort((a, b) => b.total - a.total);

  const labels = entries.map(e => e.model);
  const values = entries.map(e => e.total);
  const colors = entries.map((_, i) => COLORS[i % COLORS.length]);

  const canvas = document.getElementById("dist-pie");
  if (!canvas) return;

  // Fallback to bars if Chart.js didn't load
  if (typeof Chart === "undefined") {
    canvas.parentElement.innerHTML = '<div style="color:#fb4934;text-align:center;padding:20px;">Chart.js failed to load — check network/CDN</div>';
    return;
  }

  if (!distPieChart) {
    const ctx = canvas.getContext("2d");
    distPieChart = new Chart(ctx, {
      type: "doughnut",
      data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: "#1d2021" }] },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        aspectRatio: 2,
        cutout: "40%",
        plugins: {
          legend: {
            position: "right",
            labels: {
              color: "#bdae93",
              font: { family: "'JetBrains Mono', monospace", size: 11 },
              padding: 12,
              usePointStyle: true,
              pointStyleWidth: 10,
            },
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const pct = ((ctx.parsed / values.reduce((a, b) => a + b, 0)) * 100).toFixed(1);
                return ` ${ctx.label}: ${fmt(ctx.parsed)} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  } else {
    distPieChart.data.labels = labels;
    distPieChart.data.datasets[0].data = values;
    distPieChart.data.datasets[0].backgroundColor = colors;
    distPieChart.update();
  }
}

// ── Energy ─────────────────────────────────────────────────

async function renderEnergy() {
  // Load settings from server on every render
  const settings = await api("/api/settings");
  if (settings) {
    if (settings.energy_watts) energyWattsMap = settings.energy_watts;
    if (settings.energy_rate != null) energyRate = settings.energy_rate;
  }

  const params = new URLSearchParams({
    range: currentRange,
    watts: JSON.stringify(energyWattsMap),
    rate: energyRate,
  });
  if (filterInstance) params.set("instance", filterInstance);
  if (filterModel) params.set("model", filterModel);

  const data = await api(`/api/energy?${params}`);
  if (!data || !data.items.length) {
    document.getElementById("energy-active").textContent = "—";
    document.getElementById("energy-kwh").textContent = "—";
    document.getElementById("energy-cost").textContent = "—";
    // Build wattage summary string
    const wattSummary = Object.entries(energyWattsMap)
      .filter(([, w]) => w > 0)
      .map(([i, w]) => `${i}: ${w}W`)
      .join(" · ") || "set watts in ⚙";
    document.getElementById("energy-cost-sub").textContent = `$${energyRate.toFixed(2)}/kWh · ${wattSummary}`;
    document.getElementById("energy-breakdown").innerHTML = "";
    return;
  }

  const { totals, items } = data;

  document.getElementById("energy-active").textContent = fmtTime(totals.active_time_sec);
  document.getElementById("energy-kwh").textContent = fmtKwh(totals.energy_kwh);
  document.getElementById("energy-cost").textContent = `$${totals.cost_usd.toFixed(4)}`;
  const wattSummary = Object.entries(energyWattsMap)
    .filter(([, w]) => w > 0)
    .map(([i, w]) => `${i}: ${w}W`)
    .join(" · ") || "set watts in ⚙";
  document.getElementById("energy-cost-sub").textContent = `$${energyRate.toFixed(2)}/kWh · ${wattSummary}`;

  // Breakdown
  const container = document.getElementById("energy-breakdown");
  container.innerHTML = "";

  const totalActive = items.map(i => i.active_time_sec).reduce((a, b) => a + b, 0) || 1;

  items.forEach(item => {
    const color = getInstanceColor(item.instance);
    const pct = (item.active_time_sec / totalActive) * 100;
    const row = document.createElement("div");
    row.className = "energy-row";
    row.innerHTML = `
      <span class="energy-row-label" title="${item.instance} / ${item.model}">
        <span class="energy-dot" style="background:${color}"></span>
        ${item.model}
      </span>
      <span class="energy-row-time">${fmtTime(item.active_time_sec)} (${item.watts}W)</span>
      <div class="energy-bar-bg">
        <div class="energy-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="energy-row-kwh">${fmtKwh(item.energy_kwh)}</span>
      <span class="energy-row-cost">$${item.cost_usd.toFixed(4)}</span>
    `;
    container.appendChild(row);
  });
}

// ── Cost Comparison ────────────────────────────────────────────────

let openrouterModels = [];
let costSearchDebounce = null;
let selectedCostModel = null;

async function loadCostModel() {
  const settings = await api("/api/settings");
  if (settings && settings.cost_model) {
    selectedCostModel = settings.cost_model;
    document.getElementById("cost-search").value = selectedCostModel;
    calculateCost(selectedCostModel);
  }
}

function saveCostModel(modelId) {
  fetch("/api/settings", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({ cost_model: modelId }),
  });
}

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

  dropdown.querySelectorAll(".cost-dropdown-item").forEach(item => {
    item.addEventListener("click", () => {
      const id = item.dataset.id;
      selectedCostModel = id;
      document.getElementById("cost-search").value = id;
      dropdown.classList.remove("open");
      calculateCost(id);
      saveCostModel(id);
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

function initCostComparison() {
  const input = document.getElementById("cost-search");
  const dropdown = document.getElementById("cost-dropdown");
  if (!input || !dropdown) return;

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

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".cost-input-row")) {
      dropdown.classList.remove("open");
    }
  });
}

// ── Export / Import ───────────────────────────────────────────────

function initExportImport() {
  const btnExport = document.getElementById("btn-export");
  const btnImport = document.getElementById("btn-import");
  const fileInput = document.getElementById("import-file");
  const statusEl = document.getElementById("import-status");
  if (!btnExport || !btnImport || !fileInput) return;

  // Export
  btnExport.addEventListener("click", async () => {
    try {
      const data = await api("/api/export");
      if (!data) return;

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `llama-monitor-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Export failed:", e);
    }
  });

  // Import button triggers file picker
  btnImport.addEventListener("click", () => {
    fileInput.click();
  });

  // File selected
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    statusEl.textContent = "Reading file…";
    statusEl.className = "import-status loading";

    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        statusEl.textContent = "Importing…";

        const resp = await fetch("/api/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const result = await resp.json();

        if (result.error) {
          statusEl.textContent = `Error: ${result.error}`;
          statusEl.className = "import-status error";
          return;
        }

        const imp = result.imported;
        statusEl.textContent = `✓ Imported ${imp.snapshots} snapshots, ${imp.current_models} models, ${imp.settings} settings`;
        statusEl.className = "import-status success";

        // Refresh dashboard
        refresh();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.className = "import-status error";
      }
    };
    reader.readAsText(file);

    // Reset input so same file can be re-imported
    fileInput.value = "";
  });
}

// ── Theme Switching ────────────────────────────────────────────────────

const THEMES = {
  gruvbox: null,
  synthwave: "theme-synthwave.css",
  flashbang: "theme-flashbang.css",
  doom: "theme-doom.css",
};

function setTheme(name) {
  const linkId = "theme-stylesheet";
  let link = document.getElementById(linkId);

  if (link) link.remove();

  if (name !== "gruvbox" && THEMES[name]) {
    link = document.createElement("link");
    link.id = linkId;
    link.rel = "stylesheet";
    link.href = `/${THEMES[name]}`;
    document.head.appendChild(link);
  }

  localStorage.setItem("llama-monitor-theme", name);
  const sel = document.getElementById("theme-select");
  if (sel) sel.value = name;
}

function initTheme() {
  const saved = localStorage.getItem("llama-monitor-theme") || "gruvbox";
  setTheme(saved);
}

// ── Main ───────────────────────────────────────────────────

async function refresh() {
  const start = performance.now();

  await Promise.all([
    renderCurrentState(),
    renderTotals(),
    renderModelTable(),
    renderDistributionBars(),
    renderEnergy(),
  ]);

  // Re-calculate cost comparison for the current time range
  if (selectedCostModel) {
    calculateCost(selectedCostModel);
  }

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
(async () => {
  initTheme();
  await initSettings();
  initFilters();
  initCostComparison();
  initExportImport();
  await loadCostModel();
  refresh();

  // Auto-refresh every 15s
  refreshTimer = setInterval(refresh, 15000);
})();