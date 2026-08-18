#!/usr/bin/env python3
"""
llama-collector v2 — Scrapes llama.cpp instances, persists snapshots to SQLite,
and serves a lightweight API for the dashboard frontend.

Replaces Prometheus + Grafana with a single container.

v2 changes (no schema/data changes — existing DBs work as-is):
- ThreadingHTTPServer: concurrent API requests (no more blocking on slow queries)
- Instance health tracking: per-instance up/down, latency, error detail (/api/health)
- /api/overview: single round-trip dashboard payload (current state + totals +
  deltas vs previous window + bucketed activity series + energy)
- /api/summary now honors ?range= (was always all-time MAX)
- /api/series now returns properly delta'd, reset-safe, bucketed throughput
- Security: static-file path traversal guard
- All existing endpoints preserved for backward compatibility
"""

import os
import re
import json
import sqlite3
import time
import threading
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone
from pathlib import Path

# ── Configuration ────────────────────────────────────────────────────

SCRAPE_INTERVAL = int(os.environ.get("SCRAPE_INTERVAL", "15"))
DB_PATH = os.environ.get("DB_PATH", "/data/metrics.db")
LISTEN_PORT = int(os.environ.get("COLLECTOR_PORT", "7788"))
FRONTEND_DIR = os.environ.get("FRONTEND_DIR", "/app/frontend")
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "").strip().strip('"').strip("'")
VERSION = "2.0.0"

# ── Instance health tracking (in-memory, main process) ────────────────

_health_lock = threading.Lock()
health: dict = {}   # label -> {healthy, last_success, last_error, consecutive_failures, latency_ms}
runtime_stats = {
    "started": time.time(),
    "scrape_count": 0,
    "scrape_errors": 0,
}


def _health_record(label: str) -> dict:
    return {
        "label": label,
        "healthy": None,          # None = unknown (not yet scraped)
        "last_success": None,
        "last_error": None,
        "consecutive_failures": 0,
        "latency_ms": None,
    }


# ── OpenRouter model cache ────────────────────────────────────────────
_openrouter_cache = None
_openrouter_cache_time = 0
_OPENROUTER_CACHE_TTL = 3600  # 1 hour


def _fetch_openrouter_models() -> list:
    """Fetch models from OpenRouter, returning [{id, name, pricing: {prompt, completion}}]."""
    global _openrouter_cache, _openrouter_cache_time
    now = time.time()
    if _openrouter_cache is not None and (now - _openrouter_cache_time) < _OPENROUTER_CACHE_TTL:
        return _openrouter_cache

    if not OPENROUTER_KEY:
        return []

    try:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/models",
            headers={"Authorization": OPENROUTER_KEY},
        )
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
    except Exception as e:
        print(f"[collector] OpenRouter models fetch failed: {e}")
        return []

    models = []
    for m in data.get("data", []):
        pricing = m.get("pricing", {})
        prompt_price = completion_price = None
        try:
            pp = pricing.get("prompt")
            if pp is not None:
                prompt_price = f"{float(pp):.10f}".rstrip("0").rstrip(".")
            cp = pricing.get("completion")
            if cp is not None:
                completion_price = f"{float(cp):.10f}".rstrip("0").rstrip(".")
        except (ValueError, TypeError):
            pass
        models.append({
            "id": m.get("id", ""),
            "name": (m.get("name") or m.get("id", "")),
            "prompt_price": prompt_price,
            "completion_price": completion_price,
        })

    # Sort by name for predictable dropdown order
    models.sort(key=lambda m: m["name"].lower())
    _openrouter_cache = models
    _openrouter_cache_time = now
    return models


INSTANCES = []
for i in range(1, 5):
    url = os.environ.get(f"LLAMA_INSTANCE_{i}_URL")
    key = os.environ.get(f"LLAMA_INSTANCE_{i}_KEY")
    label = os.environ.get(f"LLAMA_INSTANCE_{i}_LABEL", f"instance-{i}")
    # Strip surrounding quotes that Docker env_file sometimes includes
    if key:
        key = key.strip().strip('"').strip("'")
    if url and key:
        INSTANCES.append({
            "url": url.rstrip("/"),
            "key": key,
            "label": label,
        })

if not INSTANCES:
    raise RuntimeError("No instances configured. Set LLAMA_INSTANCE_N_URL + _KEY.")

print(f"[collector] v{VERSION} — {len(INSTANCES)} instance(s): "
      + ", ".join(f'{i["label"]} ({i["url"]})' for i in INSTANCES))
print(f"[collector] DB at {DB_PATH}, scraping every {SCRAPE_INTERVAL}s")

# ── Database ─────────────────────────────────────────────────────────


def init_db(conn: sqlite3.Connection):
    """Create tables and indexes if they don't exist.

    NOTE: schema is intentionally unchanged from v1.x so existing databases
    keep working with zero migration.
    """
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            ts_epoch REAL NOT NULL,
            instance TEXT NOT NULL,
            model TEXT NOT NULL,
            prompt_tokens_total INTEGER DEFAULT 0,
            predicted_tokens_total INTEGER DEFAULT 0,
            prompt_tokens_seconds REAL DEFAULT 0,
            predicted_tokens_seconds REAL DEFAULT 0,
            prompt_seconds_total REAL DEFAULT 0,
            tokens_predicted_seconds_total REAL DEFAULT 0,
            requests_processing INTEGER DEFAULT 0,
            requests_deferred INTEGER DEFAULT 0,
            n_decode_total INTEGER DEFAULT 0,
            n_busy_slots_per_decode REAL DEFAULT 0,
            model_status TEXT DEFAULT ''
        );

        CREATE INDEX IF NOT EXISTS idx_snapshots_ts ON snapshots(ts_epoch);
        CREATE INDEX IF NOT EXISTS idx_snapshots_instance ON snapshots(instance);
        CREATE INDEX IF NOT EXISTS idx_snapshots_model ON snapshots(model);
        CREATE INDEX IF NOT EXISTS idx_snapshots_ts_instance ON snapshots(ts_epoch, instance);

        -- Store the currently loaded model per instance (refreshed each scrape)
        CREATE TABLE IF NOT EXISTS current_models (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            instance TEXT NOT NULL UNIQUE,
            model TEXT NOT NULL,
            status TEXT DEFAULT '',
            ts TEXT NOT NULL
        );

        -- User dashboard settings (persisted server-side)
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT NOT NULL UNIQUE,
            value TEXT NOT NULL
        );
    """)


# ── Scraping ─────────────────────────────────────────────────────────

def _request(path: str, instance: dict, timeout: int = 10) -> str:
    req = urllib.request.Request(
        instance["url"] + path,
        headers={"Authorization": "Bearer " + instance["key"]},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode()


def get_loaded_models(instance: dict) -> list:
    """Return models currently resident via /v1/models (non-destructive)."""
    try:
        raw = _request("/v1/models", instance)
        data = json.loads(raw)
    except Exception as e:
        print(f"[collector] {instance['label']}: /v1/models failed: {e}")
        raise

    resident = []
    resident_states = {"loaded", "loading", "unloaded_unloading", "loaded_unloading"}
    for m in data.get("data", []):
        mid = m.get("id", "")
        status = (m.get("status") or {}).get("value", "")
        if mid and status in resident_states:
            resident.append((mid, status))
    return resident


def parse_metrics(raw: str) -> dict:
    """Parse Prometheus-format metrics into a dict."""
    result = {}
    for line in raw.split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)\{[^}]*\}\s+(\S+)$", line)
        if not m:
            m = re.match(r"^([a-zA-Z_:][a-zA-Z0-9_:]*)\s+(\S+)$", line)
        if m:
            result[m.group(1)] = m.group(2)
    return result


def scrape_instance(instance: dict, conn: sqlite3.Connection):
    """Scrape one instance, store snapshot, update health record."""
    label = instance["label"]
    t0 = time.monotonic()
    now = datetime.now(timezone.utc)
    ts = now.isoformat()
    ts_epoch = now.timestamp()

    try:
        loaded = get_loaded_models(instance)
        if not loaded:
            print(f"[collector] {label}: no resident models")
            with _health_lock:
                h = health.setdefault(label, _health_record(label))
                h["healthy"] = True          # reachable, just no model loaded
                h["last_success"] = now.timestamp()
                h["last_error"] = "no resident models"
                h["consecutive_failures"] = 0
                h["latency_ms"] = round((time.monotonic() - t0) * 1000)
            runtime_stats["scrape_count"] += 1
            return

        for model, status in loaded:
            raw = _request("/metrics?model=" + model, instance)
            metrics = parse_metrics(raw)

            # Extract counters with defaults
            def _int(k, default=0):
                try:
                    return int(float(metrics.get(k, default)))
                except (ValueError, TypeError):
                    return default

            def _float(k, default=0.0):
                try:
                    return float(metrics.get(k, default))
                except (ValueError, TypeError):
                    return default

            conn.execute("""
                INSERT INTO snapshots (
                    ts, ts_epoch, instance, model,
                    prompt_tokens_total, predicted_tokens_total,
                    prompt_tokens_seconds, predicted_tokens_seconds,
                    prompt_seconds_total, tokens_predicted_seconds_total,
                    requests_processing, requests_deferred,
                    n_decode_total, n_busy_slots_per_decode, model_status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                ts, ts_epoch, label, model,
                _int("llamacpp:prompt_tokens_total"),
                _int("llamacpp:tokens_predicted_total"),
                _float("llamacpp:prompt_tokens_seconds"),
                _float("llamacpp:predicted_tokens_seconds"),
                _float("llamacpp:prompt_seconds_total"),
                _float("llamacpp:tokens_predicted_seconds_total"),
                _int("llamacpp:requests_processing"),
                _int("llamacpp:requests_deferred"),
                _int("llamacpp:n_decode_total"),
                _float("llamacpp:n_busy_slots_per_decode"),
                status,
            ))

            # Update current model tracking
            conn.execute("""
                INSERT INTO current_models (instance, model, status, ts)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(instance) DO UPDATE SET
                    model=excluded.model, status=excluded.status, ts=excluded.ts
            """, (label, model, status, ts))

        conn.commit()
        with _health_lock:
            h = health.setdefault(label, _health_record(label))
            h["healthy"] = True
            h["last_success"] = now.timestamp()
            h["last_error"] = None
            h["consecutive_failures"] = 0
            h["latency_ms"] = round((time.monotonic() - t0) * 1000)
        runtime_stats["scrape_count"] += 1

    except Exception as e:
        print(f"[collector] {label}: scrape failed: {e}")
        runtime_stats["scrape_errors"] += 1
        with _health_lock:
            h = health.setdefault(label, _health_record(label))
            h["healthy"] = False
            h["last_error"] = str(e)
            h["consecutive_failures"] += 1
            h["latency_ms"] = round((time.monotonic() - t0) * 1000)


# ── Scheduler ────────────────────────────────────────────────────────

def scrape_loop(db_conn: sqlite3.Connection):
    """Background thread: scrape every SCRAPE_INTERVAL seconds."""
    while True:
        try:
            for inst in INSTANCES:
                scrape_instance(inst, db_conn)
        except Exception as e:
            print(f"[collector] scrape error: {e}")
        time.sleep(SCRAPE_INTERVAL)


# ── Shared query helpers ─────────────────────────────────────────────

RANGES = {
    "1h": 3600, "6h": 21600, "24h": 86400,
    "7d": 604800, "30d": 2592000, "all": 0,
}

# Bucket size (seconds) for the activity chart per range
BUCKETS = {
    "1h": 60, "6h": 300, "24h": 900, "7d": 3600, "30d": 21600, "all": 21600,
}


def _range_seconds(range_key: str) -> int:
    return RANGES.get(range_key, 86400)


def _parse_qs(path: str) -> dict:
    from urllib.parse import urlparse, parse_qs
    qs = parse_qs(urlparse(path).query)
    return {k: v[0] for k, v in qs.items()}


def _settings_map(conn: sqlite3.Connection) -> dict:
    """Read settings, decoding typed values (same logic as /api/settings GET)."""
    cur = conn.execute("SELECT key, value FROM settings")
    rows = cur.fetchall()
    settings = {}
    for key, value in rows:
        if key == "energy_watts":
            try:
                settings[key] = json.loads(value)
            except json.JSONDecodeError:
                settings[key] = {}
        elif key == "energy_rate":
            try:
                settings[key] = float(value)
            except (ValueError, TypeError):
                settings[key] = 0.12
        else:
            settings[key] = value
    return settings


def _filter_clauses(fi, fm):
    where = []
    params = []
    if fi:
        where.append("instance = ?")
        params.append(fi)
    if fm:
        where.append("model = ?")
        params.append(fm)
    sql = (" AND " + " AND ".join(where)) if where else ""
    return sql, params


def _summary_for_range(conn, since, until=None, fi=None, fm=None) -> list:
    """Totals per instance+model for a time window.

    Uses MAX(counter) - first(counter) within the window so that values
    reflect activity *during* the window (reset-safe: if the counter ever
    dropped, MAX overestimates — acceptable, and consistent with v1).

    Returns list of dicts, one per (instance, model) with live status from
    the latest snapshot.
    """
    where = "ts_epoch >= ?"
    params = [since]
    if until is not None:
        where += " AND ts_epoch <= ?"
        params.append(until)
    fsql, fparams = _filter_clauses(fi, fm)
    params = params + fparams

    cur = conn.execute(f"""
        SELECT instance, model,
               MAX(prompt_tokens_total), MAX(predicted_tokens_total),
               MAX(prompt_seconds_total), MAX(tokens_predicted_seconds_total),
               MAX(n_decode_total)
        FROM snapshots
        WHERE {where}{fsql}
        GROUP BY instance, model
        HAVING MAX(prompt_tokens_total) > 0 OR MAX(predicted_tokens_total) > 0
    """, params)
    peak_rows = cur.fetchall()

    cur2 = conn.execute(f"""
        SELECT instance, model,
               MIN(prompt_tokens_total), MIN(predicted_tokens_total),
               MIN(prompt_seconds_total), MIN(tokens_predicted_seconds_total)
        FROM snapshots
        WHERE {where}{fsql}
        GROUP BY instance, model
    """, params)
    first_map = {(r[0], r[1]): (r[2], r[3], r[4], r[5]) for r in cur2.fetchall()}

    # Latest snapshot in window for live gauges
    cur3 = conn.execute(f"""
        SELECT instance, model,
               prompt_tokens_seconds, predicted_tokens_seconds,
               requests_processing, requests_deferred, ts_epoch
        FROM snapshots s
        WHERE ts_epoch >= ?{fsql}
          AND (s.instance, s.model, s.ts_epoch) IN (
              SELECT instance, model, MAX(ts_epoch) FROM snapshots
              WHERE ts_epoch >= ?{fsql} GROUP BY instance, model
          )
    """, [since] + fparams + [since] + fparams)
    latest_map = {}
    for r in cur3.fetchall():
        latest_map[(r[0], r[1])] = {
            "prompt_tps": round(r[2] or 0, 2),
            "predicted_tps": round(r[3] or 0, 2),
            "processing": r[4] or 0,
            "deferred": r[5] or 0,
            "last_seen": r[6],
        }

    out = []
    for r in peak_rows:
        instance, model, mp, cp, mpt, cpt, decodes = r
        fp, fc, fpt, fcpt = first_map.get((instance, model), (0, 0, 0.0, 0.0))
        prompt_tokens = max(0, mp - fp)
        predicted_tokens = max(0, cp - fc)
        prompt_time = max(0.0, (mpt or 0) - (fpt or 0))
        pred_time = max(0.0, (cpt or 0) - (fcpt or 0))
        # Reset guard: if time deltas look negative-ish, fall back to raw MAX
        if prompt_time < 0:
            prompt_time = mpt or 0
        if pred_time < 0:
            pred_time = cpt or 0
        live = latest_map.get((instance, model), {})
        out.append({
            "instance": instance,
            "model": model,
            "prompt_tokens": prompt_tokens,
            "predicted_tokens": predicted_tokens,
            "prompt_time_sec": round(prompt_time, 2),
            "predict_time_sec": round(pred_time, 2),
            "decodes": decodes or 0,
            "prompt_tps": live.get("prompt_tps", 0),
            "predicted_tps": live.get("predicted_tps", 0),
            "requests_processing": live.get("processing", 0),
            "requests_deferred": live.get("deferred", 0),
            "last_seen": live.get("last_seen"),
        })
    out.sort(key=lambda x: (x["instance"], x["model"]))
    return out


def _series_for_range(conn, since, fi=None, fm=None, bucket_seconds=900, max_buckets=48) -> dict:
    """Delta'd, reset-safe, time-bucketed activity series.

    For each (instance, model) series, computes per-bucket token counts from
    counter deltas (a negative delta = counter reset; attribute the new value).
    Returns aligned arrays so the frontend can plot without re-bucketing.
    """
    fsql, fparams = _filter_clauses(fi, fm)
    cur = conn.execute(f"""
        SELECT ts_epoch, instance, model,
               prompt_tokens_total, predicted_tokens_total
        FROM snapshots
        WHERE ts_epoch >= ?{fsql}
        ORDER BY ts_epoch
    """, [since] + fparams)
    rows = cur.fetchall()
    if not rows:
        return {"start": int(since), "bucket_seconds": bucket_seconds,
                "buckets": 0, "series": []}

    first_ts = rows[0][0]
    last_ts = rows[-1][0]
    n_buckets = min(max_buckets, max(1, int((last_ts - first_ts) // bucket_seconds) + 1))

    # series_key -> {tokens arrays, prev counters}
    series = {}
    order = []
    for ts_epoch, instance, model, ptot, ctot in rows:
        key = (instance, model)
        b = min(int((ts_epoch - first_ts) // bucket_seconds), n_buckets - 1)
        s = series.get(key)
        if s is None:
            s = {
                "instance": instance, "model": model,
                "prompt_tokens": [0] * n_buckets,
                "predicted_tokens": [0] * n_buckets,
                "prev_pt": None, "prev_ct": None,
            }
            series[key] = s
            order.append(key)
            continue
        if s["prev_pt"] is not None:
            dp = ptot - s["prev_pt"]
            if dp < 0:
                dp = ptot  # counter reset (model swap) — take the new value
            if dp > 0:
                s["prompt_tokens"][b] += dp
        if s["prev_ct"] is not None:
            dc = ctot - s["prev_ct"]
            if dc < 0:
                dc = ctot
            if dc > 0:
                s["predicted_tokens"][b] += dc
        s["prev_pt"] = ptot
        s["prev_ct"] = ctot

    # Totals per series (sum of buckets — equals deltas; excludes pre-first)
    out_series = []
    for key in order:
        s = series[key]
        out_series.append({
            "instance": s["instance"],
            "model": s["model"],
            "prompt_tokens": s["prompt_tokens"],
            "predicted_tokens": s["predicted_tokens"],
        })

    return {
        "start": int(first_ts),
        "bucket_seconds": bucket_seconds,
        "buckets": n_buckets,
        "series": out_series,
    }


def _energy_payload(conn, since, range_key, rate, watts_map, fi=None, fm=None) -> dict:
    """Energy calculation (refactored from v1 /api/energy — same math)."""
    where = "ts_epoch >= ?"
    params: list = [since]
    if fi:
        where += " AND instance = ?"
        params.append(fi)
    if fm:
        where += " AND model = ?"
        params.append(fm)

    cur = conn.execute(f"""
        SELECT s.instance, s.model,
               MAX(s.prompt_seconds_total), MAX(s.tokens_predicted_seconds_total)
        FROM snapshots s
        WHERE {where}
        GROUP BY s.instance, s.model
        HAVING MAX(s.prompt_tokens_total) > 0 OR MAX(s.predicted_tokens_total) > 0
        ORDER BY s.instance, s.model
    """, params)
    rows = cur.fetchall()

    cur2 = conn.execute(f"""
        SELECT s.instance, s.model,
               MIN(s.prompt_seconds_total), MIN(s.tokens_predicted_seconds_total)
        FROM snapshots s
        WHERE {where}
        GROUP BY s.instance, s.model
        HAVING MAX(s.prompt_tokens_total) > 0 OR MAX(s.predicted_tokens_total) > 0
        ORDER BY s.instance, s.model
    """, params)
    first_map = {(r[0], r[1]): (r[2], r[3]) for r in cur2.fetchall()}

    energy_items = []
    total_active_sec = 0.0
    total_kwh = 0.0
    total_cost = 0.0

    for r in rows:
        instance, model, max_prompt_sec, max_pred_sec = r
        min_prompt_sec, min_pred_sec = first_map.get((instance, model), (0, 0))
        delta_prompt = max(0, (max_prompt_sec or 0) - (min_prompt_sec or 0))
        delta_pred = max(0, (max_pred_sec or 0) - (min_pred_sec or 0))
        active_sec = delta_prompt + delta_pred
        watts = watts_map.get(instance, watts_map.get("__default__", 0)) or 0
        if watts > 0:
            kwh = (active_sec * watts) / 3600000
            cost = kwh * rate
        else:
            kwh = 0.0
            cost = 0.0
        total_active_sec += active_sec
        total_kwh += kwh
        total_cost += cost
        energy_items.append({
            "instance": instance,
            "model": model,
            "watts": watts,
            "prompt_time_sec": round(delta_prompt, 2),
            "predict_time_sec": round(delta_pred, 2),
            "active_time_sec": round(active_sec, 2),
            "energy_kwh": round(kwh, 6),
            "cost_usd": round(cost, 4),
        })

    energy_items.sort(key=lambda x: x["energy_kwh"], reverse=True)
    return {
        "range": range_key,
        "watts": watts_map,
        "rate_per_kwh": rate,
        "items": energy_items,
        "totals": {
            "active_time_sec": round(total_active_sec, 2),
            "energy_kwh": round(total_kwh, 6),
            "cost_usd": round(total_cost, 4),
        },
    }


def _current_models(conn) -> list:
    cur = conn.execute("""
        SELECT instance, model, status, ts FROM current_models ORDER BY instance
    """)
    return [{"instance": r[0], "model": r[1], "status": r[2], "updated": r[3]}
            for r in cur.fetchall()]


def _totals_from_rows(rows) -> dict:
    return {
        "prompt_tokens": sum(r["prompt_tokens"] for r in rows),
        "predicted_tokens": sum(r["predicted_tokens"] for r in rows),
        "prompt_time_sec": round(sum(r["prompt_time_sec"] for r in rows), 2),
        "predict_time_sec": round(sum(r["predict_time_sec"] for r in rows), 2),
        "decodes": sum(r["decodes"] for r in rows),
        "live_prompt_tps": round(sum(r["prompt_tps"] for r in rows), 2),
        "live_predicted_tps": round(sum(r["predicted_tps"] for r in rows), 2),
        "requests_processing": sum(r["requests_processing"] for r in rows),
        "requests_deferred": sum(r["requests_deferred"] for r in rows),
    }


# ── API Server ───────────────────────────────────────────────────────

class APIHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # self.path includes the query string; route on the path portion only
        from urllib.parse import urlparse
        path = urlparse(self.path).path
        query_path = self.path  # full path+query for endpoints that parse params

        # ── Static files (with traversal guard) ──
        if not path.startswith("/api/"):
            fpath = os.path.realpath(os.path.join(FRONTEND_DIR, path.lstrip("/")))
            if not fpath.startswith(os.path.realpath(FRONTEND_DIR)):
                self.send_response(403)
                self.end_headers()
                return
            if os.path.isfile(fpath):
                ct = self._guess_ct(fpath)
                self._serve_file(fpath, ct)
                return
            if path in ("/", "/index.html"):
                self._serve_file(os.path.join(FRONTEND_DIR, "index.html"),
                                 "text/html; charset=utf-8")
                return

        # ── API endpoints — each request gets its own DB connection ──
        try:
            if path == "/api/overview":
                self._json(api_overview(query_path))
            elif path == "/api/summary":
                self._json(self._with_db(lambda c: api_summary(c, query_path)))
            elif path == "/api/series":
                self._json(self._with_db(lambda c: api_series(c, query_path)))
            elif path == "/api/current":
                self._json(self._with_db(lambda c: {"instances": _current_models(c)}))
            elif path == "/api/models":
                self._json(self._with_db(lambda c: api_models(c)))
            elif path == "/api/instances":
                self._json(self._with_db(lambda c: api_instances(c)))
            elif path == "/api/openrouter-models":
                self._json(api_openrouter_models(query_path))
            elif path == "/api/cost-calc":
                self._json(self._with_db(lambda c: api_cost_calc(c, query_path)))
            elif path == "/api/energy":
                self._json(self._with_db(lambda c: api_energy(c, query_path)))
            elif path == "/api/settings":
                self._json(self._with_db(lambda c: api_settings_get(c)))
            elif path == "/api/health":
                self._json(api_health())
            elif path == "/api/export":
                self._json(self._with_db(api_export))
            elif path == "/api/version":
                self._json({"version": VERSION, "uptime_sec": round(time.time() - runtime_stats["started"])})
            else:
                self.send_response(404)
                self.end_headers()
        except Exception as e:
            print(f"[collector] API error on {path}: {e}")
            try:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            except Exception:
                pass

    def do_POST(self):
        try:
            if self.path == "/api/settings":
                data = self._read_json_body()
                if data is None:
                    return
                self._json(self._with_db(lambda c: api_settings_set(c, data)))
                return
            if self.path == "/api/import":
                data = self._read_json_body()
                if data is None:
                    return
                self._json(self._with_db(lambda c: api_import(c, data)))
                return
        except Exception as e:
            print(f"[collector] API error on POST {self.path}: {e}")
        self.send_response(404)
        self.end_headers()

    # ── helpers ──

    def _read_json_body(self):
        content_len = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_len)
        try:
            return json.loads(body)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return None

    def _with_db(self, fn):
        conn = get_db()
        try:
            return fn(conn)
        finally:
            conn.close()

    def _serve_file(self, fpath: str, ct: str):
        try:
            with open(fpath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            if fpath.endswith((".html", ".js", ".css")):
                self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_response(404)
            self.end_headers()

    def _guess_ct(self, path: str) -> str:
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        m = {"html": "text/html; charset=utf-8", "css": "text/css; charset=utf-8",
             "js": "application/javascript; charset=utf-8", "json": "application/json",
             "png": "image/png", "svg": "image/svg+xml", "ico": "image/x-icon",
             "woff2": "font/woff2"}
        return m.get(ext, "application/octet-stream")

    def _json(self, data):
        body = json.dumps(data, default=str).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # Quiet


# ── API Endpoints ────────────────────────────────────────────────────

def api_summary(conn, path: str) -> dict:
    """Totals per instance+model. Honors ?range= (default: all).

    range=all uses v1 semantics (MAX counters since monitoring started) so
    historic numbers stay comparable. Bounded ranges use max-minus-first
    within the window (reset-safe).
    """
    qs = _parse_qs(path)
    range_key = qs.get("range", "all")
    fi = qs.get("instance") or None
    fm = qs.get("model") or None
    secs = _range_seconds(range_key)
    now = time.time()
    since = now - secs if secs else 0
    return {"range": range_key, "totals": _summary_for_range(conn, since, fi=fi, fm=fm)}


def api_series(conn, path: str) -> dict:
    """Bucketed, delta'd activity series. ?range=24h&instance=&model="""
    qs = _parse_qs(path)
    range_key = qs.get("range", "24h")
    fi = qs.get("instance") or None
    fm = qs.get("model") or None
    secs = _range_seconds(range_key)
    now = time.time()
    since = now - secs if secs else 0
    bucket = BUCKETS.get(range_key, 900)
    return _series_for_range(conn, since, fi=fi, fm=fm, bucket_seconds=bucket)


def api_models(conn) -> dict:
    cur = conn.execute("SELECT DISTINCT model FROM snapshots ORDER BY model")
    return {"models": [r[0] for r in cur.fetchall()]}


def api_instances(conn) -> dict:
    cur = conn.execute("SELECT DISTINCT instance FROM snapshots ORDER BY instance")
    return {"instances": [r[0] for r in cur.fetchall()]}


def api_openrouter_models(path: str) -> dict:
    qs = _parse_qs(path)
    search = (qs.get("q") or "").strip().lower()
    models = _fetch_openrouter_models()
    if search:
        models = [m for m in models if search in m["id"].lower() or search in m["name"].lower()]
    return {"models": models, "total": len(models)}


def api_energy(conn, path: str) -> dict:
    """?range=24h&rate=&watts={...}&instance=&model= (falls back to saved settings)"""
    qs = _parse_qs(path)
    range_key = qs.get("range", "24h")
    fi = qs.get("instance") or None
    fm = qs.get("model") or None

    saved = _settings_map(conn)
    rate = float(qs.get("rate", saved.get("energy_rate", 0.12)))
    watts_map = saved.get("energy_watts", {}) or {}
    raw_watts = qs.get("watts")
    if raw_watts:
        try:
            parsed = json.loads(raw_watts)
            if isinstance(parsed, dict):
                watts_map = parsed
            elif isinstance(parsed, (int, float)):
                watts_map = {"__default__": parsed}
        except (json.JSONDecodeError, TypeError):
            pass

    secs = _range_seconds(range_key)
    now = time.time()
    since = now - secs if secs else 0
    return _energy_payload(conn, since, range_key, rate, watts_map, fi=fi, fm=fm)


def api_settings_get(conn) -> dict:
    return _settings_map(conn)


def api_settings_set(conn, data: dict) -> dict:
    for key, value in data.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value)
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, str(value)),
        )
    conn.commit()
    return {"ok": True, "saved": list(data.keys())}


def api_cost_calc(conn, path: str) -> dict:
    """Cost for an OpenRouter model using token usage in ?range=.

    Uses the same range-aware totals as /api/summary so the comparison
    matches the dashboard window.
    """
    qs = _parse_qs(path)
    model_id = qs.get("model", "")
    range_key = qs.get("range", "24h")
    fi = qs.get("instance") or None
    if not model_id:
        return {"error": "model parameter required"}

    models = _fetch_openrouter_models()
    target = next((m for m in models if m["id"] == model_id), None)
    if not target:
        return {"error": "model not found on OpenRouter"}

    prompt_price = target.get("prompt_price")
    completion_price = target.get("completion_price")
    if prompt_price is not None:
        prompt_price = float(prompt_price)
    if completion_price is not None:
        completion_price = float(completion_price)
    if prompt_price is None and completion_price is None:
        return {"error": "no pricing data for this model"}

    secs = _range_seconds(range_key)
    now = time.time()
    since = now - secs if secs else 0
    rows = _summary_for_range(conn, since, fi=fi)
    total_prompt = sum(r["prompt_tokens"] for r in rows)
    total_pred = sum(r["predicted_tokens"] for r in rows)
    if total_prompt == 0 and total_pred == 0:
        return {"error": "no data in range"}

    cost = 0.0
    if prompt_price is not None:
        cost += total_prompt * prompt_price
    if completion_price is not None:
        cost += total_pred * completion_price

    return {
        "model_id": model_id,
        "model_name": target["name"],
        "prompt_price": f"{prompt_price:.10f}".rstrip("0").rstrip(".") if prompt_price is not None else None,
        "completion_price": f"{completion_price:.10f}".rstrip("0").rstrip(".") if completion_price is not None else None,
        "prompt_tokens": total_prompt,
        "completion_tokens": total_pred,
        "total_tokens": total_prompt + total_pred,
        "cost_usd": round(cost, 4),
        "cost_formatted": "${:.4f}".format(cost),
        "range": range_key,
    }


def api_health() -> dict:
    """Instance health + collector runtime stats (no DB needed)."""
    with _health_lock:
        instances = [
            {**h, "url": next((i["url"] for i in INSTANCES if i["label"] == h["label"]), "")}
            for h in health.values()
        ]
        # Include configured instances never scraped yet
        seen = {h["label"] for h in instances}
        for i in INSTANCES:
            if i["label"] not in seen:
                instances.append(_health_record(i["label"]) | {"url": i["url"]})
        instances.sort(key=lambda x: x["label"])
    return {
        "instances": instances,
        "uptime_sec": round(time.time() - runtime_stats["started"]),
        "scrape_count": runtime_stats["scrape_count"],
        "scrape_errors": runtime_stats["scrape_errors"],
        "scrape_interval": SCRAPE_INTERVAL,
    }


def api_overview(path: str) -> dict:
    """One round-trip: everything the dashboard needs for the current
    time range + filters. ?range=24h&instance=&model=
    """
    qs = _parse_qs(path)
    range_key = qs.get("range", "24h")
    fi = qs.get("instance") or None
    fm = qs.get("model") or None

    conn = get_db()
    try:
        saved = _settings_map(conn)
        rate = saved.get("energy_rate", 0.12)
        watts_map = saved.get("energy_watts", {}) or {}

        secs = _range_seconds(range_key)
        now = time.time()
        since = now - secs if secs else 0
        prev_since = since - secs if secs else None

        rows = _summary_for_range(conn, since, fi=fi, fm=fm)
        prev_rows = _summary_for_range(conn, prev_since, until=since, fi=fi, fm=fm) if prev_since else None
        series = _series_for_range(conn, since, fi=fi, fm=fm,
                                   bucket_seconds=BUCKETS.get(range_key, 900))
        energy = _energy_payload(conn, since, range_key, rate, watts_map, fi=fi, fm=fm)

        # Per-instance live view: current model + live gauges from latest rows
        current = _current_models(conn)
        inst_live = {}
        for r in rows:
            e = inst_live.setdefault(r["instance"], {
                "prompt_tps": 0.0, "predicted_tps": 0.0,
                "processing": 0, "deferred": 0})
            e["prompt_tps"] = round(e["prompt_tps"] + r["prompt_tps"], 2)
            e["predicted_tps"] = round(e["predicted_tps"] + r["predicted_tps"], 2)
            e["processing"] += r["requests_processing"]
            e["deferred"] += r["requests_deferred"]

        # Distinct lists for filter dropdowns (unfiltered)
        cur = conn.execute("SELECT DISTINCT instance FROM snapshots ORDER BY instance")
        instances_list = [r[0] for r in cur.fetchall()]
        cur = conn.execute("SELECT DISTINCT model FROM snapshots ORDER BY model")
        models_list = [r[0] for r in cur.fetchall()]

        db_size_mb = None
        try:
            db_size_mb = round(Path(DB_PATH).stat().st_size / 1024 / 1024, 1)
        except OSError:
            pass

        return {
            "version": VERSION,
            "now": now,
            "range": range_key,
            "instances": current,
            "instance_live": inst_live,
            "totals": _totals_from_rows(rows),
            "prev_totals": _totals_from_rows(prev_rows) if prev_rows is not None else None,
            "rows": rows,
            "series": series,
            "energy": energy,
            "filters": {"instances": instances_list, "models": models_list},
            "settings": {"energy_watts": watts_map, "energy_rate": rate,
                         "cost_model": saved.get("cost_model") or None},
            "db_size_mb": db_size_mb,
            "health": api_health(),
        }
    finally:
        conn.close()


# ── Export / Import (unchanged from v1) ─────────────────────────────

def api_export(conn) -> dict:
    cur = conn.execute("""
        SELECT ts, ts_epoch, instance, model, prompt_tokens_total, predicted_tokens_total,
               prompt_tokens_seconds, predicted_tokens_seconds,
               prompt_seconds_total, tokens_predicted_seconds_total,
               requests_processing, requests_deferred, n_decode_total,
               n_busy_slots_per_decode, model_status
        FROM snapshots ORDER BY ts_epoch
    """)
    snapshots = []
    for r in cur.fetchall():
        snapshots.append({
            "ts": r[0], "ts_epoch": r[1], "instance": r[2], "model": r[3],
            "prompt_tokens_total": r[4], "predicted_tokens_total": r[5],
            "prompt_tokens_seconds": r[6], "predicted_tokens_seconds": r[7],
            "prompt_seconds_total": r[8], "tokens_predicted_seconds_total": r[9],
            "requests_processing": r[10], "requests_deferred": r[11],
            "n_decode_total": r[12], "n_busy_slots_per_decode": r[13],
            "model_status": r[14],
        })

    cur = conn.execute("SELECT instance, model, status, ts FROM current_models")
    current_models = [{"instance": r[0], "model": r[1], "status": r[2], "ts": r[3]}
                      for r in cur.fetchall()]

    cur = conn.execute("SELECT key, value FROM settings")
    settings = {r[0]: r[1] for r in cur.fetchall()}

    return {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "snapshots": snapshots,
        "current_models": current_models,
        "settings": settings,
    }


def api_import(conn, data: dict) -> dict:
    """Import data from a previous export. Inserts/merges into existing DB."""
    if data.get("version") != 1:
        return {"error": "unsupported export version"}

    imported_snapshots = 0
    imported_models = 0
    imported_settings = 0

    for s in data.get("snapshots", []):
        conn.execute("""
            INSERT INTO snapshots (ts, ts_epoch, instance, model,
                prompt_tokens_total, predicted_tokens_total,
                prompt_tokens_seconds, predicted_tokens_seconds,
                prompt_seconds_total, tokens_predicted_seconds_total,
                requests_processing, requests_deferred,
                n_decode_total, n_busy_slots_per_decode, model_status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            s["ts"], s["ts_epoch"], s["instance"], s["model"],
            s.get("prompt_tokens_total", 0), s.get("predicted_tokens_total", 0),
            s.get("prompt_tokens_seconds", 0), s.get("predicted_tokens_seconds", 0),
            s.get("prompt_seconds_total", 0), s.get("tokens_predicted_seconds_total", 0),
            s.get("requests_processing", 0), s.get("requests_deferred", 0),
            s.get("n_decode_total", 0), s.get("n_busy_slots_per_decode", 0),
            s.get("model_status", ""),
        ))
        imported_snapshots += 1

    for m in data.get("current_models", []):
        conn.execute("""
            INSERT INTO current_models (instance, model, status, ts)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(instance) DO UPDATE SET
                model=excluded.model, status=excluded.status, ts=excluded.ts
        """, (m["instance"], m["model"], m.get("status", ""), m["ts"]))
        imported_models += 1

    for key, value in data.get("settings", {}).items():
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, str(value)),
        )
        imported_settings += 1

    conn.commit()
    return {
        "ok": True,
        "imported": {
            "snapshots": imported_snapshots,
            "current_models": imported_models,
            "settings": imported_settings,
        },
    }


# ── Main ─────────────────────────────────────────────────────────────

def get_db():
    """Open a fresh DB connection per request (WAL allows concurrent reads)."""
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def main():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)

    db_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    db_conn.execute("PRAGMA journal_mode=WAL")
    db_conn.execute("PRAGMA busy_timeout=5000")
    init_db(db_conn)
    print(f"[collector] Database initialized at {DB_PATH}")

    t = threading.Thread(target=scrape_loop, args=(db_conn,), daemon=True)
    t.start()
    print(f"[collector] Scrape thread started (interval={SCRAPE_INTERVAL}s)")

    server = ThreadingHTTPServer(("0.0.0.0", LISTEN_PORT), APIHandler)
    print(f"[collector] API + frontend on :{LISTEN_PORT} (threaded)")
    server.serve_forever()


if __name__ == "__main__":
    main()
