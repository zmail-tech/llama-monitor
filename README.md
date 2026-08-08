# llama-monitor

Lightweight, self-hosted dashboard for monitoring llama.cpp instances — token usage, throughput, and model activity over time. Replaces the Prometheus + Grafana stack with a single container that scrapes, persists to SQLite, and serves a Gruvbox-themed dashboard.

## Features

- **Real-time metrics** — scrapes llama.cpp `/metrics` every 15 seconds
- **Router-mode safe** — discovers loaded models via `/v1/models` before scraping, avoiding load/unload churn
- **Persistent history** — SQLite backend stores snapshots across restarts
- **Time-range filtering** — 1h · 6h · 24h · 7d · 30d · All
- **Per-model breakdown** — tokens in/out, throughput, decode counts, active status
- **Zero dependencies** — single container, no external databases or message queues
- **Gruvbox dark theme** — clean, terminal-native aesthetic

## Architecture

```
┌──────────────┐     ┌──────────────┐
│ llama.cpp    │     │ llama.cpp    │
│ 192.168.1.210│     │ 192.168.1.229│
└──────┬───────┘     └──────┬───────┘
       │ /v1/models          │ /v1/models
       │ /metrics            │ /metrics
       └───────┬─────────────┘
               ▼
     ┌──────────────────┐
     │   collector       │  :7788
     │  ┌──────────────┐ │
     │  │ scrape thread │──► SQLite (persistent)
     │  │ API server    │──► JSON endpoints
     │  │ static files  │──► Gruvbox dashboard
     │  └──────────────┘ │
     └──────────────────┘
```

## Quick Start

### Prerequisites

- llama.cpp instances running with `--metrics` enabled
- Docker + Docker Compose

### 1. Configure

```bash
cp .env.skel .env
# Edit .env with your instance URLs and API keys
```

### 2. Launch

```bash
docker compose up -d
```

### 3. Open Dashboard

Navigate to `http://<host-ip>:7788/`

## Configuration

### Environment Variables

| Variable | Description | Required |
|----------|-------------|----------|
| `LLAMA_INSTANCE_N_URL` | Base URL of llama.cpp instance | Yes |
| `LLAMA_INSTANCE_N_KEY` | API key for authentication | Yes |
| `LLAMA_INSTANCE_N_LABEL` | Display name for the instance | No (defaults to `instance-N`) |
| `SCRAPE_INTERVAL` | Seconds between scrapes (default: 15) | No |
| `COLLECTOR_PORT` | HTTP port to listen on (default: 7788) | No |
| `DB_PATH` | SQLite database path (default: `/data/metrics.db`) | No |

Replace `N` with 1, 2, 3, 4 for up to 4 instances. Add more by editing `collector/collector.py`.

### llama.cpp Setup

Each instance must be started with `--metrics`:

```yaml
# docker-compose.yml example
services:
  llama:
    image: ghcr.io/ggerganov/llama.cpp:server
    command: >
      --host 0.0.0.0 --port 8000
      --model /models/your-model.gguf
      --metrics
      --models-max 1
      --models-autoload
    environment:
      - LLAMA_API_KEY=your-key-here
```

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/summary` | Aggregate token totals by instance+model |
| `GET /api/current` | Current loaded model per instance |
| `GET /api/models` | List of all known models |
| `GET /api/instances` | List of all instance labels |
| `GET /api/series?range=24h` | Time-series data for charts |

## Project Structure

```
llama-monitor/
├── .env.skel              # Example environment variables
├── docker-compose.yml     # Service orchestration
├── collector/
│   ├── Dockerfile
│   └── collector.py       # Scraper + SQLite + API + static server
└── frontend/
    ├── index.html         # Dashboard HTML
    ├── style.css          # Gruvbox dark theme
    └── app.js             # Chart.js charts, live refresh
```

## License

MIT
