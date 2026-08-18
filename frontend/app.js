/* ═══════════════════════════════════════════════════════════
   Llama.cpp Monitor — Dashboard JavaScript (v2)
   Single-round-trip /api/overview refresh, SVG charts,
   sortable table, instance health, energy, cost comparison.
   ═══════════════════════════════════════════════════════════ */

// ── State ──────────────────────────────────────────────────
let currentRange = "24h";
let filterInstance = "";
let filterModel = "";
let refreshTimer = null;
let lastOverview = null;

// Energy settings (synced from server on every overview)
let energyWattsMap = {};
let energyRate = 0.12;

// Legend muting: set of "instance/model" keys hidden from chart
const mutedSeries = new Set();

// Table sort state
let sortKey = "total";
let sortDir = -1; // -1 desc, 1 asc

// ── Formatting helpers ─────────────────────────────────────

function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
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
  return sec.toFixed(0) + "s";
}

function fmtClock(ts) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function fmtAgo(ts) {
  if (!ts) return "never";
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return Math.floor(s) + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return (s / 3600).toFixed(1) + "h ago";
  return (s / 86400).toFixed(1) + "d ago";
}

function fmtKwh(kwh) {
  if (kwh == null || isNaN(kwh) || kwh === 0) return "—";
  if (kwh < 0.001) return (kwh * 1000).toFixed(1) + " Wh";
  return kwh.toFixed(4) + " kWh";
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── Theme-aware colors ─────────────────────────────────────

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}

function seriesColor(i) {
  return cssVar(`--series-${(i % 8) + 1}`) || "#888";
}

// Stable per-key color index (instance/model pairs + instances)
const colorIdx = {};
let colorCounter = 0;
function stableColor(key) {
  if (!(key in colorIdx)) colorIdx[key] = colorCounter++;
  return seriesColor(colorIdx[key]);
}

// ── API ────────────────────────────────────────────────────

async function api(path) {
  try {
    const r = await fetch(path);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) {
    console.error("API error:", path, e);
    return null;
  }
}

// ── Status badge + header ──────────────────────────────────

function renderHeaderStatus(data) {
  const badge = document.getElementById("status-badge");
  const h = data.health;
  if (!h || !h.instances.length) {
    badge.textContent = "● collecting";
    badge.className = "badge badge-live";
    return;
  }
  const down = h.instances.filter(i => i.healthy === false);
  const busy = (data.totals.requests_processing || 0) > 0;
  if (down.length === 0) {
    badge.textContent = busy ? "● live — processing" : "● collecting";
    badge.className = "badge badge-live";
  } else if (down.length < h.instances.length) {
    badge.textContent = `● degraded — ${down.length} down`;
    badge.className = "badge badge-degraded";
    badge.title = down.map(d => `${d.label}: ${d.last_error || "down"}`).join("\n");
  } else {
    badge.textContent = "● all instances down";
    badge.className = "badge badge-offline";
    badge.title = down.map(d => `${d.label}: ${d.last_error || "down"}`).join("\n");
  }
  document.getElementById("last-update").textContent =
    `updated ${new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}

// ── KPI row ────────────────────────────────────────────────

function setDelta(el, cur, prev) {
  if (el == null) return;
  if (prev == null || prev === 0) {
    el.textContent = "";
    el.className = "delta flat";
    return;
  }
  const pct = ((cur - prev) / prev) * 100;
  const arrow = pct > 0.5 ? "▲" : pct < -0.5 ? "▼" : "•";
  el.textContent = ` ${arrow} ${Math.abs(pct) >= 100 ? Math.abs(pct).toFixed(0) : Math.abs(pct).toFixed(1)}%`;
  el.className = "delta " + (pct > 0.5 ? "up" : pct < -0.5 ? "down" : "flat");
  el.title = "vs previous period";
}

function renderKPIs(data) {
  const t = data.totals;
  const p = data.prev_totals;
  const total = (t.prompt_tokens || 0) + (t.predicted_tokens || 0);
  const prevTotal = p ? (p.prompt_tokens || 0) + (p.predicted_tokens || 0) : null;

  document.getElementById("total-prompt").textContent = fmt(t.prompt_tokens);
  document.getElementById("total-predicted").textContent = fmt(t.predicted_tokens);
  document.getElementById("total-all").textContent = fmt(total);

  setDelta(document.getElementById("delta-prompt"), t.prompt_tokens, p && p.prompt_tokens);
  setDelta(document.getElementById("delta-predicted"), t.predicted_tokens, p && p.predicted_tokens);

  const rangeLabel = currentRange === "all" ? "all time" : `last ${currentRange}`;
  document.getElementById("range-label").textContent = rangeLabel;
  document.getElementById("range-label-2").textContent = rangeLabel;

  const liveTps = t.live_predicted_tps || 0;
  document.getElementById("live-throughput").textContent = liveTps > 0 ? liveTps.toFixed(1) : "—";
  document.getElementById("live-throughput-sub").textContent =
    liveTps > 0 ? `${(t.live_prompt_tps || 0).toFixed(0)} t/s prompt` : "no active generation";

  const e = data.energy.totals;
  document.getElementById("energy-cost").textContent = e.cost_usd > 0 ? `$${e.cost_usd.toFixed(4)}` : "—";
  const wattSummary = Object.entries(energyWattsMap)
    .filter(([, w]) => w > 0)
    .map(([i, w]) => `${i}: ${w}W`)
    .join(" · ") || "set watts in ⚙";
  document.getElementById("energy-cost-sub").textContent = `$${energyRate.toFixed(4)}/kWh`;

  document.getElementById("active-requests").textContent = t.requests_processing || 0;
  document.getElementById("deferred-sub").textContent = `${t.requests_deferred || 0} deferred`;
}

// ── Instance cards ─────────────────────────────────────────

function renderInstances(data) {
  const grid = document.getElementById("instance-grid");
  grid.innerHTML = "";

  const live = data.instance_live || {};
  const healthMap = {};
  (data.health.instances || []).forEach(h => { healthMap[h.label] = h; });

  data.instances.forEach(inst => {
    const lv = live[inst.instance] || { prompt_tps: 0, predicted_tps: 0, processing: 0, deferred: 0 };
    const hp = healthMap[inst.instance] || {};
    const down = hp.healthy === false;
    const busy = (lv.processing || 0) > 0;

    const statusClass = down ? "status-down"
      : inst.status === "loaded" ? "status-loaded"
      : inst.status === "loading" ? "status-loading"
      : "status-unloaded";
    const statusText = down ? "down" : inst.status;

    const card = document.createElement("div");
    card.className = "instance-card";
    card.innerHTML = `
      <div class="instance-card-top">
        <span class="instance-name">
          <span class="instance-dot ${busy ? "dot-busy" : ""}" style="background:${down ? cssVar("--red") : stableColor(inst.instance)}"></span>
          ${esc(inst.instance)}
        </span>
        <span class="instance-status ${statusClass}">${esc(statusText)}</span>
      </div>
      <div class="instance-model" title="${esc(inst.model)}">${esc(inst.model)}</div>
      <div class="instance-metrics">
        <div class="instance-metric">
          <div class="im-value">${lv.predicted_tps > 0 ? lv.predicted_tps.toFixed(1) : "—"}</div>
          <div class="im-label">gen t/s</div>
        </div>
        <div class="instance-metric">
          <div class="im-value">${lv.prompt_tps > 0 ? lv.prompt_tps.toFixed(0) : "—"}</div>
          <div class="im-label">prompt t/s</div>
        </div>
        <div class="instance-metric">
          <div class="im-value">${lv.processing || 0}${lv.deferred ? `+${lv.deferred}` : ""}</div>
          <div class="im-label">req${lv.deferred ? " +def" : ""}</div>
        </div>
      </div>
      <div class="instance-health">
        <span class="${down ? "err" : "ok"}">
          ${down ? "✕ " + esc(hp.last_error || "unreachable")
                 : "✓ " + (hp.latency_ms != null ? `${hp.latency_ms}ms` : "ok") +
                   (hp.last_success ? " · " + fmtAgo(hp.last_success) : "")}
        </span>
        <span>${esc(inst.updated ? "since " + fmtAgo(new Date(inst.updated).getTime() / 1000) : "")}</span>
      </div>
    `;
    grid.appendChild(card);
  });

  document.getElementById("instance-count").textContent = data.instances.length;
}

// ── Activity chart (SVG stacked bars) ──────────────────────

function niceCeil(v) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  let nf;
  if (f <= 1) nf = 1;
  else if (f <= 2) nf = 2;
  else if (f <= 5) nf = 5;
  else nf = 10;
  return nf * exp;
}

function renderActivityChart(data) {
  const container = document.getElementById("activity-chart");
  const legendEl = document.getElementById("activity-legend");
  const seriesData = (data.series && data.series.series) || [];
  const visible = seriesData.filter(s => !mutedSeries.has(s.instance + "/" + s.model));

  if (!visible.length) {
    container.innerHTML = '<div class="chart-empty">No activity in this time range</div>';
    legendEl.innerHTML = "";
    return;
  }

  const nBuckets = data.series.buckets;
  const W = 1000, H = 300, padL = 62, padB = 26, padT = 10, padR = 8;
  const plotW = W - padL - padR, plotH = H - padT - padB;

  // Stack: for each bucket, sum prompt then predicted per series
  const bucketSums = Array.from({ length: nBuckets }, () => ({}));
  visible.forEach(s => {
    for (let b = 0; b < nBuckets; b++) {
      const bs = bucketSums[b];
      const k = s.instance + "/" + s.model;
      bs[k] = bs[k] || { prompt: 0, pred: 0 };
      bs[k].prompt += s.prompt_tokens[b] || 0;
      bs[k].pred += s.predicted_tokens[b] || 0;
    }
  });

  const totals = bucketSums.map(bs =>
    Object.values(bs).reduce((a, v) => a + v.prompt + v.pred, 0));
  const maxVal = niceCeil(Math.max(...totals, 1));

  const bw = plotW / nBuckets;
  const y = v => padT + plotH - (v / maxVal) * plotH;

  let rects = "";
  for (let b = 0; b < nBuckets; b++) {
    const x = padL + b * bw;
    let cum = 0;
    // Prompt layer first (bottom), then generated (on top)
    for (const layer of ["prompt", "pred"]) {
      let yBottom = cum;
      for (const [key, v] of Object.entries(bucketSums[b])) {
        const val = v[layer];
        if (!val) continue;
        const hTop = (yBottom + val) / maxVal * plotH;
        const hPix = (val / maxVal) * plotH;
        if (hPix < 0.5) continue;
        const color = stableColor(key);
        const [si, mi] = key.split("/");
        rects += `<rect x="${(x + 1).toFixed(1)}" y="${(padT + plotH - hTop).toFixed(1)}" width="${Math.max(bw - 2, 1).toFixed(1)}" height="${hPix.toFixed(1)}" fill="${color}" opacity="0.92">`
          + `<title>${esc(si)} / ${esc(mi)}\n${layer === "prompt" ? "prompt" : "generated"}: ${fmtNum(val)} tokens</title></rect>`;
        yBottom += val;
      }
    }
  }

  // Gridlines + Y labels
  let grid = "";
  const ticks = 4;
  for (let i = 0; i <= ticks; i++) {
    const v = (maxVal / ticks) * i;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="${cssVar("--bg2")}" stroke-width="1"/>`;
    grid += `<text x="${padL - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="10" fill="${cssVar("--fg4")}">${fmt(v)}</text>`;
  }

  // X labels: ~5 evenly spaced
  let xlabels = "";
  const nLab = Math.min(5, nBuckets);
  const start = data.series.start;
  for (let i = 0; i < nLab; i++) {
    const b = Math.round((i * (nBuckets - 1)) / Math.max(nLab - 1, 1));
    const ts = start + b * data.series.bucket_seconds;
    const d = new Date(ts * 1000);
    const label = currentRange === "1h"
      ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const xx = padL + b * bw + bw / 2;
    xlabels += `<text x="${xx.toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="${cssVar("--fg4")}">${label}</text>`;
  }

  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="token activity chart">
      ${grid}
      ${rects}
      ${xlabels}
    </svg>`;

  // Legend
  legendEl.innerHTML = visible.map(s => {
    const key = s.instance + "/" + s.model;
    const total = [...s.prompt_tokens, ...s.predicted_tokens].reduce((a, b) => a + b, 0);
    return `<span class="legend-item" data-key="${esc(key)}" title="click to show/hide">
      <span class="legend-swatch" style="background:${stableColor(key)}"></span>
      ${esc(s.instance)} · ${esc(s.model)} <span style="color:${cssVar("--fg4")}">(${fmt(total)})</span>
    </span>`;
  }).join("");

  legendEl.querySelectorAll(".legend-item").forEach(el => {
    el.classList.toggle("muted", mutedSeries.has(el.dataset.key));
    el.addEventListener("click", () => {
      const k = el.dataset.key;
      if (mutedSeries.has(k)) mutedSeries.delete(k);
      else mutedSeries.add(k);
      renderActivityChart(lastOverview);
    });
  });
}

// ── Distribution by model (stacked bars) ───────────────────

function renderDistribution(data) {
  const el = document.getElementById("dist-chart");

  // Aggregate by model across instances (respect filters — server already did)
  const modelMap = {};
  data.rows.forEach(r => {
    const m = modelMap[r.model] = modelMap[r.model] || { prompt: 0, predicted: 0 };
    m.prompt += r.prompt_tokens || 0;
    m.predicted += r.predicted_tokens || 0;
  });

  const entries = Object.entries(modelMap)
    .map(([model, v]) => ({ model, ...v, total: v.prompt + v.predicted }))
    .sort((a, b) => b.total - a.total);

  if (!entries.length) {
    el.innerHTML = '<div class="chart-empty">No data in this range</div>';
    return;
  }

  const grand = entries.reduce((a, e) => a + e.total, 0) || 1;
  el.innerHTML = entries.map(e => {
    const pct = (e.total / grand) * 100;
    const promptPct = (e.prompt / grand) * 100;
    const color = stableColor("__model__" + e.model);
    return `<div class="dist-row">
      <span class="dist-label" title="${esc(e.model)}"><span class="dist-dot" style="background:${color}"></span>${esc(e.model)}</span>
      <div class="dist-bar-bg">
        <div class="dist-bar-fill" style="width:${Math.max(pct, 1.5).toFixed(1)}%;background:linear-gradient(90deg, ${color} 0%, ${color} ${promptPct / pct * 100}%, ${cssVar("--bg3")} ${promptPct / pct * 100}%)">
          <span class="bar-pct">${pct >= 8 ? pct.toFixed(1) + "%" : ""}</span>
        </div>
      </div>
      <span class="dist-value">${fmt(e.total)}</span>
    </div>`;
  }).join("");
}

// ── Energy ─────────────────────────────────────────────────

function renderEnergy(data) {
  const e = data.energy;
  document.getElementById("energy-active").textContent = fmtTime(e.totals.active_time_sec);
  document.getElementById("energy-kwh").textContent = fmtKwh(e.totals.energy_kwh);

  const container = document.getElementById("energy-breakdown");
  if (!e.items.length) {
    container.innerHTML = '<div class="energy-empty">No energy data in this range' +
      (Object.values(energyWattsMap).some(w => w > 0) ? "" : " — set wattage in ⚙ Settings") + "</div>";
    return;
  }

  const maxActive = Math.max(...e.items.map(i => i.active_time_sec), 1);
  container.innerHTML = e.items.map(item => {
    const pct = (item.active_time_sec / maxActive) * 100;
    return `<div class="energy-row">
      <span class="energy-row-label" title="${esc(item.instance)} / ${esc(item.model)}">
        <span class="energy-dot" style="background:${stableColor(item.instance)}"></span>
        ${esc(item.model)}
      </span>
      <span class="energy-row-time">${fmtTime(item.active_time_sec)}${item.watts ? ` @ ${item.watts}W` : ""}</span>
      <div class="energy-bar-bg"><div class="energy-bar-fill" style="width:${Math.max(pct, 1).toFixed(1)}%;background:${stableColor(item.instance)}"></div></div>
      <span class="energy-row-kwh">${fmtKwh(item.energy_kwh)}</span>
      <span class="energy-row-cost">$${item.cost_usd.toFixed(4)}</span>
    </div>`;
  }).join("");
}

// ── Model table (sortable) ─────────────────────────────────

function renderTable(data) {
  const tbody = document.getElementById("model-tbody");
  const rows = data.rows.map(r => ({
    ...r,
    total: (r.prompt_tokens || 0) + (r.predicted_tokens || 0),
  }));

  rows.sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case "instance": va = a.instance; vb = b.instance; break;
      case "model": va = a.model; vb = b.model; break;
      case "prompt": va = a.prompt_tokens; vb = b.prompt_tokens; break;
      case "predicted": va = a.predicted_tokens; vb = b.predicted_tokens; break;
      case "prompt_tps": va = a.prompt_tps; vb = b.prompt_tps; break;
      case "predicted_tps": va = a.predicted_tps; vb = b.predicted_tps; break;
      case "prompt_time": va = a.prompt_time_sec; vb = b.prompt_time_sec; break;
      case "predict_time": va = a.predict_time_sec; vb = b.predict_time_sec; break;
      case "decodes": va = a.decodes; vb = b.decodes; break;
      case "active": va = a.requests_processing; vb = b.requests_processing; break;
      case "total":
      default: va = a.total; vb = b.total; break;
    }
    if (typeof va === "string") return va.localeCompare(vb) * sortDir;
    return ((va || 0) - (vb || 0)) * sortDir;
  });

  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="instance-cell"><span class="energy-dot" style="background:${stableColor(r.instance)}"></span>${esc(r.instance)}</td>
      <td class="model-name-cell">${esc(r.model)}</td>
      <td class="num">${fmtNum(r.prompt_tokens)}</td>
      <td class="num">${fmtNum(r.predicted_tokens)}</td>
      <td class="num accent-yellow">${fmtNum(r.total)}</td>
      <td class="num ${r.predicted_tps > 0 ? "status-badge-live" : ""}">${r.predicted_tps > 0 ? r.predicted_tps.toFixed(1) : "—"}</td>
      <td class="num ${r.prompt_tps > 0 ? "status-badge-live" : ""}">${r.prompt_tps > 0 ? r.prompt_tps.toFixed(0) : "—"}</td>
      <td class="num">${fmtTime(r.prompt_time_sec)}</td>
      <td class="num">${fmtTime(r.predict_time_sec)}</td>
      <td class="num">${fmtNum(r.decodes)}</td>
      <td>${r.requests_processing > 0
        ? '<span class="badge badge-live">active</span>'
        : '<span class="badge badge-idle">idle</span>'}</td>
    </tr>`).join("");

  // Sort indicators
  document.querySelectorAll("#model-table thead th").forEach(th => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.sort === sortKey) {
      th.classList.add(sortDir === 1 ? "sorted-asc" : "sorted-desc");
    }
  });
}

function initTableSort() {
  document.querySelectorAll("#model-table thead th").forEach(th => {
    th.addEventListener("click", () => {
      const key = th.dataset.sort;
      if (!key) return;
      if (sortKey === key) sortDir = -sortDir;
      else { sortKey = key; sortDir = -1; }
      if (lastOverview) renderTable(lastOverview);
    });
  });
}

// ── Cost Comparison ────────────────────────────────────────

let openrouterModels = [];
let costSearchDebounce = null;
let selectedCostModel = null;

async function loadCostModel() {
  if (lastOverview && lastOverview.settings.cost_model) {
    selectedCostModel = lastOverview.settings.cost_model;
    document.getElementById("cost-search").value = selectedCostModel;
    calculateCost(selectedCostModel);
  }
}

function saveCostModel(modelId) {
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    dropdown.innerHTML = '<div class="cost-dropdown-empty">No models found — check OPENROUTER_API_KEY</div>';
    dropdown.classList.add("open");
    return;
  }

  const shown = models.slice(0, 50);
  const fmtPrice = (p) => p != null ? `$${(parseFloat(p) * 1e6).toFixed(2)}/M` : "—";
  dropdown.innerHTML = shown.map(m => {
    const pp = fmtPrice(m.prompt_price);
    const cp = fmtPrice(m.completion_price);
    return `<div class="cost-dropdown-item" data-id="${esc(m.id)}">
      <span class="model-name" title="${esc(m.id)}">${esc(m.name || m.id)}</span>
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

  const data = await api(`/api/cost-calc?model=${encodeURIComponent(modelId)}&range=${currentRange}`);
  if (!data || data.error) {
    resultEl.innerHTML = `<div class="cost-placeholder">${esc(data && data.error ? data.error : "Error calculating cost")}</div>`;
    return;
  }

  const rangeLabel = currentRange === "all" ? "all time" : `last ${currentRange}`;
  resultEl.innerHTML = `
    <div class="cost-result-card">
      <div class="cost-result-header">
        <span class="cost-result-model">${esc(data.model_name)}</span>
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
        <div class="cost-total-label">If served via OpenRouter</div>
        <div class="cost-total-value">${esc(data.cost_formatted)}</div>
      </div>
    </div>`;
}

function initCostComparison() {
  const input = document.getElementById("cost-search");
  const dropdown = document.getElementById("cost-dropdown");
  if (!input || !dropdown) return;

  input.addEventListener("focus", () => {
    if (!input.value) loadOpenRouterModels();
  });

  input.addEventListener("input", () => {
    clearTimeout(costSearchDebounce);
    costSearchDebounce = setTimeout(() => loadOpenRouterModels(input.value), 250);
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".cost-input-row")) dropdown.classList.remove("open");
  });
}

// ── Filters ────────────────────────────────────────────────

function renderFilterOptions(data) {
  const instSelect = document.getElementById("filter-instance");
  const modelSelect = document.getElementById("filter-model");
  const instCur = instSelect.value;
  const modelCur = modelSelect.value;

  instSelect.innerHTML = '<option value="">All Instances</option>' +
    (data.filters.instances || []).map(i => `<option value="${esc(i)}">${esc(i)}</option>`).join("");
  modelSelect.innerHTML = '<option value="">All Models</option>' +
    (data.filters.models || []).map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join("");

  instSelect.value = (data.filters.instances || []).includes(filterInstance) ? filterInstance : "";
  modelSelect.value = (data.filters.models || []).includes(filterModel) ? filterModel : "";
  filterInstance = instSelect.value;
  filterModel = modelSelect.value;
}

function initFilters() {
  document.getElementById("filter-instance").addEventListener("change", (e) => {
    filterInstance = e.target.value;
    refresh();
  });
  document.getElementById("filter-model").addEventListener("change", (e) => {
    filterModel = e.target.value;
    refresh();
  });
}

// ── Settings modal ─────────────────────────────────────────

function buildWattsInputs(instances) {
  const container = document.getElementById("watts-inputs");
  container.innerHTML = instances.map(inst => {
    const w = energyWattsMap[inst] || "";
    return `<div class="watts-input-row">
      <label for="watt-${esc(inst)}">${esc(inst)}</label>
      <input type="number" id="watt-${esc(inst)}" data-instance="${esc(inst)}" min="0" step="1" value="${w}" placeholder="W">
    </div>`;
  }).join("");
}

async function initSettings() {
  const modal = document.getElementById("settings-modal");
  const btn = document.getElementById("settings-btn");
  const close = document.getElementById("settings-close");
  const saveBtn = document.getElementById("settings-save");
  const rateInput = document.getElementById("setting-rate");
  const themeSelect = document.getElementById("theme-select");

  btn.addEventListener("click", () => {
    // Rebuild watt inputs from current instances + settings
    const insts = (lastOverview && lastOverview.filters.instances) || [];
    buildWattsInputs(insts.length ? insts : Object.keys(energyWattsMap));
    if (lastOverview && lastOverview.settings) {
      rateInput.value = lastOverview.settings.energy_rate;
      const tm = localStorage.getItem("llama-monitor-theme") || "gruvbox";
      themeSelect.value = tm;
    }
    modal.classList.add("open");
  });
  close.addEventListener("click", () => modal.classList.remove("open"));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.classList.remove("open");
  });

  saveBtn.addEventListener("click", () => {
    const watts = {};
    document.querySelectorAll("#watts-inputs input").forEach(input => {
      const val = parseFloat(input.value) || 0;
      if (val > 0) watts[input.dataset.instance] = val;
    });
    energyWattsMap = watts;
    energyRate = parseFloat(rateInput.value) || 0;

    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ energy_watts: watts, energy_rate: energyRate }),
    }).then(() => refresh());

    saveBtn.textContent = "✓ Saved";
    saveBtn.classList.add("saved");
    setTimeout(() => {
      modal.classList.remove("open");
      setTimeout(() => {
        saveBtn.textContent = "Save";
        saveBtn.classList.remove("saved");
      }, 400);
    }, 600);
  });

  themeSelect.addEventListener("change", (e) => setTheme(e.target.value));
}

// ── Export / Import ────────────────────────────────────────

function initExportImport() {
  const btnExport = document.getElementById("btn-export");
  const btnImport = document.getElementById("btn-import");
  const fileInput = document.getElementById("import-file");
  const statusEl = document.getElementById("import-status");
  if (!btnExport || !btnImport || !fileInput) return;

  btnExport.addEventListener("click", async () => {
    const data = await api("/api/export");
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `llama-monitor-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  btnImport.addEventListener("click", () => fileInput.click());

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
        refresh();
      } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.className = "import-status error";
      }
    };
    reader.readAsText(file);
    fileInput.value = "";
  });
}

// ── Theme switching ────────────────────────────────────────

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
    link.onload = () => { if (lastOverview) refresh(); };
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

// ── Refresh ────────────────────────────────────────────────

async function refresh() {
  const params = new URLSearchParams({ range: currentRange });
  if (filterInstance) params.set("instance", filterInstance);
  if (filterModel) params.set("model", filterModel);

  const data = await api(`/api/overview?${params}`);
  if (!data) {
    const badge = document.getElementById("status-badge");
    badge.textContent = "● collector unreachable";
    badge.className = "badge badge-offline";
    return;
  }

  lastOverview = data;
  if (data.settings) {
    energyWattsMap = data.settings.energy_watts || {};
    energyRate = data.settings.energy_rate || 0.12;
  }

  renderHeaderStatus(data);
  renderFilterOptions(data);
  renderKPIs(data);
  renderInstances(data);
  renderActivityChart(data);
  renderDistribution(data);
  renderEnergy(data);
  renderTable(data);

  if (selectedCostModel) calculateCost(selectedCostModel);
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

// ── Init ───────────────────────────────────────────────────

(async () => {
  initTheme();
  initSettings();
  initFilters();
  initCostComparison();
  initExportImport();
  initTableSort();
  await refresh();
  if (lastOverview) loadCostModel();

  // Auto-refresh every 15s
  refreshTimer = setInterval(refresh, 15000);
})();
