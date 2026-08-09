#!/usr/bin/env python3
"""
llama-collector — Scrapes llama.cpp instances, persists snapshots to SQLite,
and serves a lightweight API for the dashboard frontend.

Replaces Prometheus + Grafana with a single container.
"""

import os
import re
import json
import sqlite3
import time
import threading
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone
from pathlib import Path

# ── Configuration ────────────────────────────────────────────────────

SCRAPE_INTERVAL = int(os.environ.get("SCRAPE_INTERVAL", "15"))
DB_PATH = os.environ.get("DB_PATH", "/data/metrics.db")
LISTEN_PORT = int(os.environ.get("COLLECTOR_PORT", "7788"))
FRONTEND_DIR = "/app/frontend"
OPENROUTER_KEY = os.environ.get("OPENROUTER_API_KEY", "").strip().strip('"').strip("'")

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
for i in (1, 2, 3, 4):
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

print(f"[collector] {len(INSTANCES)} instance(s): "
      + ", ".join(f'{i["label"]} ({i["url"]})' for i in INSTANCES))
print(f"[collector] DB at {DB_PATH}, scraping every {SCRAPE_INTERVAL}s")

# ── Database ─────────────────────────────────────────────────────────

def init_db(conn: sqlite3.Connection):
    """Create tables and indexes if they don't exist."""
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
        return []

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
    """Scrape one instance, store snapshot."""
    now = datetime.now(timezone.utc)
    ts = now.isoformat()
    ts_epoch = now.timestamp()

    loaded = get_loaded_models(instance)
    if not loaded:
        print(f"[collector] {instance['label']}: no resident models")
        return

    for model, status in loaded:
        try:
            raw = _request("/metrics?model=" + model, instance)
            metrics = parse_metrics(raw)
        except Exception as e:
            print(f"[collector] {instance['label']}/{model}: metrics failed: {e}")
            continue

        # Extract integer counters with defaults
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
            ts, ts_epoch, instance["label"], model,
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
        """, (instance["label"], model, status, ts))

    conn.commit()


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


# ── API Server ───────────────────────────────────────────────────────

class APIHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if path := self.path:
            # Serve static files
            if path == "/" or path == "/index.html":
                self._serve_file(os.path.join(FRONTEND_DIR, "index.html"), "text/html; charset=utf-8")
                return
            if path.startswith("/"):
                fpath = os.path.join(FRONTEND_DIR, path.lstrip("/"))
                if os.path.isfile(fpath):
                    self._serve_file(fpath, self._guess_ct(fpath))
                    return

            # API endpoints
            if path == "/api/summary":
                self._json_response(api_summary(self.server.conn))
                return
            if path.startswith("/api/series"):
                self._json_response(api_series(self.server.conn, self.path))
                return
            if path == "/api/current":
                self._json_response(api_current(self.server.conn))
                return
            if path == "/api/models":
                self._json_response(api_models(self.server.conn))
                return
            if path == "/api/instances":
                self._json_response(api_instances(self.server.conn))
                return
            if path.startswith("/api/openrouter-models"):
                self._json_response(api_openrouter_models(self.path))
                return
            if path.startswith("/api/cost-calc"):
                self._json_response(api_cost_calc(self.server.conn, self.path))
                return
            if path.startswith("/api/energy"):
                self._json_response(api_energy(self.server.conn, self.path))
                return
            if path == "/api/settings":
                self._json_response(api_settings_get(self.server.conn))
                return

        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        if self.path == "/api/settings":
            content_len = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(content_len)
            try:
                data = json.loads(body)
            except json.JSONDecodeError:
                self.send_response(400)
                self.end_headers()
                return
            self._json_response(api_settings_set(self.server.conn, data))
            return

        self.send_response(404)
        self.end_headers()

    def _serve_file(self, fpath: str, ct: str):
        try:
            with open(fpath, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", ct)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except FileNotFoundError:
            self.send_response(404)
            self.end_headers()

    def _guess_ct(self, path: str) -> str:
        ext = path.rsplit(".", 1)[-1].lower() if "." in path else ""
        map = {"html": "text/html; charset=utf-8", "css": "text/css; charset=utf-8",
               "js": "application/javascript; charset=utf-8", "json": "application/json",
               "png": "image/png", "svg": "image/svg+xml", "ico": "image/x-icon"}
        return map.get(ext, "application/octet-stream")

    def _json_response(self, data: dict):
        body = json.dumps(data, default=str).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):
        pass  # Quiet


# ── API Endpoints ────────────────────────────────────────────────────

def api_summary(conn: sqlite3.Connection) -> dict:
    """All-time totals per instance+model (latest snapshot)."""
    cur = conn.execute("""
        SELECT instance, model,
               prompt_tokens_total, predicted_tokens_total,
               prompt_tokens_seconds, predicted_tokens_seconds,
               prompt_seconds_total, tokens_predicted_seconds_total,
               n_decode_total, requests_processing, requests_deferred,
               ts
        FROM snapshots s
        WHERE (s.instance, s.model, s.ts_epoch) IN (
            SELECT instance, model, MAX(ts_epoch) FROM snapshots
            GROUP BY instance, model
        )
        ORDER BY instance, model
    """)
    rows = cur.fetchall()
    return {
        "totals": [{
            "instance": r[0], "model": r[1],
            "prompt_tokens": r[2], "predicted_tokens": r[3],
            "prompt_tokens_per_sec": round(r[4], 2),
            "predicted_tokens_per_sec": round(r[5], 2),
            "prompt_time_sec": round(r[6], 3),
            "predict_time_sec": round(r[7], 3),
            "decodes": r[8],
            "requests_processing": r[9],
            "requests_deferred": r[10],
            "last_seen": r[11],
        } for r in rows]
    }


def api_series(conn: sqlite3.Connection, path: str) -> dict:
    """Time series data with optional time range filter.
    Query params: ?range=1h|6h|24h|7d|30d|all&metric=tokens|throughput
    """
    from urllib.parse import urlparse, parse_qs
    qs = parse_qs(urlparse(path).query)
    range_key = qs.get("range", ["24h"])[0]
    metric = qs.get("metric", ["tokens"])[0]

    # Parse range
    now = time.time()
    ranges = {
        "1h": 3600, "6h": 21600, "24h": 86400,
        "7d": 604800, "30d": 2592000, "all": 0,
    }
    seconds_back = ranges.get(range_key, 86400)
    since = now - seconds_back if seconds_back else 0

    if metric == "throughput":
        # Compute per-interval throughput from deltas
        cur = conn.execute("""
            SELECT ts_epoch, instance, model,
                   predicted_tokens_seconds, prompt_tokens_seconds
            FROM snapshots
            WHERE ts_epoch >= ?
            ORDER BY ts_epoch
        """, (since,))
    else:
        # Cumulative token counts over time
        cur = conn.execute("""
            SELECT ts_epoch, instance, model,
                   prompt_tokens_total, predicted_tokens_total
            FROM snapshots
            WHERE ts_epoch >= ?
            ORDER BY ts_epoch
        """, (since,))

    rows = cur.fetchall()
    return {
        "range": range_key,
        "metric": metric,
        "points": [
            {
                "ts": r[0],
                "instance": r[1],
                "model": r[2],
                "v1": r[3],
                "v2": r[4],
            }
            for r in rows
        ]
    }


def api_current(conn: sqlite3.Connection) -> dict:
    """Currently loaded model per instance."""
    cur = conn.execute("""
        SELECT instance, model, status, ts
        FROM current_models
        ORDER BY instance
    """)
    return {
        "instances": [{
            "instance": r[0], "model": r[1],
            "status": r[2], "updated": r[3],
        } for r in cur.fetchall()]
    }


def api_models(conn: sqlite3.Connection) -> dict:
    """All unique models ever seen."""
    cur = conn.execute("""
        SELECT DISTINCT model FROM snapshots ORDER BY model
    """)
    return {"models": [r[0] for r in cur.fetchall()]}


def api_instances(conn: sqlite3.Connection) -> dict:
    """All unique instances."""
    cur = conn.execute("""
        SELECT DISTINCT instance FROM snapshots ORDER BY instance
    """)
    return {"instances": [r[0] for r in cur.fetchall()]}


def api_openrouter_models(path: str) -> dict:
    """List OpenRouter models, optionally filtered by search query."""
    from urllib.parse import urlparse, parse_qs
    qs = parse_qs(urlparse(path).query)
    search = qs.get("q", [""])[0].strip().lower()

    models = _fetch_openrouter_models()
    if search:
        models = [m for m in models if search in m["id"].lower() or search in m["name"].lower()]

    return {
        "models": models,
        "total": len(models),
    }


def api_energy(conn: sqlite3.Connection, path: str) -> dict:
    """Calculate energy consumption from active processing time.
    Query params: ?range=24h&rate=0.12&watts={"llama-1":400,"llama-2":150}&instance=llama-1&model=Qwen-Max
    """
    from urllib.parse import urlparse, parse_qs
    qs = parse_qs(urlparse(path).query)
    range_key = qs.get("range", ["24h"])[0]
    rate = float(qs.get("rate", [0.12])[0])
    filter_instance = qs.get("instance", [None])[0]
    filter_model = qs.get("model", [None])[0]

    # Parse per-instance wattage JSON: {"llama-1": 400, "llama-2": 150}
    # Also supports plain number for backward compat: watts=450
    watts_map = {}
    raw_watts = qs.get("watts", ["{}"])[0]
    try:
        parsed = json.loads(raw_watts)
        if isinstance(parsed, dict):
            watts_map = parsed
        elif isinstance(parsed, (int, float)):
            watts_map = {"__default__": parsed}
    except (json.JSONDecodeError, TypeError):
        pass

    now = time.time()
    ranges = {
        "1h": 3600, "6h": 21600, "24h": 86400,
        "7d": 604800, "30d": 2592000, "all": 0,
    }
    seconds_back = ranges.get(range_key, 86400)
    since = now - seconds_back if seconds_back else 0

    where = "ts_epoch >= ?"
    params: list = [since]
    if filter_instance:
        where += " AND instance = ?"
        params.append(filter_instance)
    if filter_model:
        where += " AND model = ?"
        params.append(filter_model)

    cur = conn.execute(f"""
        SELECT s.instance, s.model,
               MAX(s.prompt_seconds_total), MAX(s.tokens_predicted_seconds_total)
        FROM snapshots s
        WHERE {where}
        GROUP BY s.instance, s.model
        ORDER BY s.instance, s.model
    """, params)
    rows = cur.fetchall()

    cur2 = conn.execute(f"""
        SELECT s.instance, s.model,
               MIN(s.prompt_seconds_total), MIN(s.tokens_predicted_seconds_total)
        FROM snapshots s
        WHERE {where}
        GROUP BY s.instance, s.model
        ORDER BY s.instance, s.model
    """, params)
    first_rows = cur2.fetchall()

    first_map = {(r[0], r[1]): (r[2], r[3]) for r in first_rows}

    energy_items = []
    total_active_sec = 0.0
    total_kwh = 0.0
    total_cost = 0.0

    for r in rows:
        instance, model, max_prompt_sec, max_pred_sec = r
        min_prompt_sec, min_pred_sec = first_map.get((instance, model), (0, 0))

        # Handle counter resets: if max < min, the counter reset — use max as the value
        delta_prompt = max(0, max_prompt_sec - min_prompt_sec) if max_prompt_sec >= min_prompt_sec else max_prompt_sec
        delta_pred = max(0, max_pred_sec - min_pred_sec) if max_pred_sec >= min_pred_sec else max_pred_sec
        active_sec = delta_prompt + delta_pred

        watts = watts_map.get(instance, watts_map.get("__default__", 0))
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


def api_settings_get(conn: sqlite3.Connection) -> dict:
    """Read dashboard settings from SQLite."""
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
        elif key == "cost_model":
            settings[key] = value or None
        else:
            settings[key] = value
    return settings


def api_settings_set(conn: sqlite3.Connection, data: dict) -> dict:
    """Save dashboard settings to SQLite."""
    for key, value in data.items():
        if isinstance(value, (dict, list)):
            value = json.dumps(value)
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
            (key, str(value)),
        )
    conn.commit()
    return {"ok": True, "saved": list(data.keys())}


def api_cost_calc(conn: sqlite3.Connection, path: str) -> dict:
    """Calculate cost for a given OpenRouter model based on total token usage."""
    from urllib.parse import urlparse, parse_qs
    qs = parse_qs(urlparse(path).query)
    model_id = qs.get("model", [""])[0]
    range_key = qs.get("range", ["24h"])[0]

    if not model_id:
        return {"error": "model parameter required"}

    # Find pricing for this model
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

    # Get token totals for the requested range
    now = time.time()
    ranges = {
        "1h": 3600, "6h": 21600, "24h": 86400,
        "7d": 604800, "30d": 2592000, "all": 0,
    }
    seconds_back = ranges.get(range_key, 86400)
    since = now - seconds_back if seconds_back else 0

    # Get earliest and latest snapshots in range to compute deltas
    cur = conn.execute("""
        SELECT MIN(ts_epoch) as first_ts, MAX(ts_epoch) as last_ts
        FROM snapshots WHERE ts_epoch >= ?
    """, (since,))
    row = cur.fetchone()
    if not row or row[0] is None:
        return {"error": "no data in range"}

    first_ts, last_ts = row

    # Get totals at first and last snapshot
    def get_totals_at(ts):
        c = conn.execute("""
            SELECT COALESCE(SUM(prompt_tokens_total), 0),
                   COALESCE(SUM(predicted_tokens_total), 0)
            FROM snapshots s
            WHERE s.ts_epoch = (
                SELECT MAX(s2.ts_epoch) FROM snapshots s2
                WHERE s2.ts_epoch <= ?
                  AND s2.instance = s.instance
                  AND s2.model = s.model
            )
        """, (ts,))
        r = c.fetchone()
        return r[0], r[1]

    first_prompt, first_pred = get_totals_at(first_ts)
    last_prompt, last_pred = get_totals_at(last_ts)

    delta_prompt = max(0, last_prompt - first_prompt)
    delta_pred = max(0, last_pred - first_pred)

    cost = 0.0
    if prompt_price is not None:
        cost += delta_prompt * prompt_price
    if completion_price is not None:
        cost += delta_pred * completion_price

    return {
        "model_id": model_id,
        "model_name": target["name"],
        "prompt_price": f"${prompt_price:.10f}".rstrip("0").rstrip(".") if prompt_price is not None else None,
        "completion_price": f"${completion_price:.10f}".rstrip("0").rstrip(".") if completion_price is not None else None,
        "prompt_tokens": delta_prompt,
        "completion_tokens": delta_pred,
        "total_tokens": delta_prompt + delta_pred,
        "cost_usd": round(cost, 4),
        "cost_formatted": "${:.4f}".format(cost),
        "range": range_key,
    }


# ── Main ─────────────────────────────────────────────────────────────

def main():
    # Ensure DB directory exists
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)

    db_conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    db_conn.execute("PRAGMA journal_mode=WAL")
    db_conn.execute("PRAGMA busy_timeout=5000")
    init_db(db_conn)
    print(f"[collector] Database initialized at {DB_PATH}")

    # Start background scrape thread
    t = threading.Thread(target=scrape_loop, args=(db_conn,), daemon=True)
    t.start()
    print(f"[collector] Scrape thread started (interval={SCRAPE_INTERVAL}s)")

    # Set up HTTP server with DB connection
    server = HTTPServer(("0.0.0.0", LISTEN_PORT), APIHandler)
    server.conn = db_conn  # Attach for API handlers to use

    print(f"[collector] API + frontend on :{LISTEN_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()