# llama-monitor

Lightweight, self-hosted dashboard for monitoring llama.cpp instances — token usage, throughput, model activity, energy consumption, and cost comparison. Replaces the Prometheus + Grafana stack with a single container that scrapes, persists to SQLite, and serves a themed dashboard.

## Features

- **Real-time metrics** — scrapes llama.cpp `/metrics` every 15 seconds
- **Router-mode safe** — discovers loaded models via `/v1/models` before scraping, avoiding load/unload churn
- **Persistent history** — SQLite backend stores snapshots across restarts
- **Energy tracking** — GPU wattage per instance, electricity rate, energy consumption calculation
- **OpenRouter cost comparison** — Model search, pricing lookup, cost calculation
- **Cost model persistence** — Selected model saved to SQLite settings
- **Theme support** — Gruvbox, Synthwave, Flashbang, DOOM themes
- **Data portability** — Export/Import JSON for migrating data between instances
- **Time-range filtering** — 1h · 6h · 24h · 7d · 30d · All
- **Per-model breakdown** — tokens in/out, throughput, decode counts, active status
- **Zero dependencies** — single container, no external databases or message queues
- **GHCR deployment** — Pre-built Docker image available on GitHub Container Registry

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
     │  │ static files  │──► Themed dashboard
     │  └──────────────┘ │
     │  ┌──────────────┐ │
     │  │ OpenRouter API│──► Cost comparison
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
| `OPENROUTER_API_KEY` | API key for OpenRouter pricing data | No |

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

## Dashboard Features

### Energy Tracking

- Configure GPU wattage per instance in settings
- Set electricity rate ($/kWh)
- View active time, energy consumption (kWh), and estimated cost
- Breakdown by instance and model

### OpenRouter Cost Comparison

- Search OpenRouter models by name or ID
- View pricing (input/output per million tokens)
- Select a model for cost comparison
- Automatic cost calculation based on token usage

### Themes

- **Gruvbox** — Original dark theme
- **Synthwave** — Neon retro-futuristic
- **Flashbang** — High contrast warning style
- **DOOM** — Dark red hell aesthetic

### Data Portability

- **Export** — Download all metrics, models, and settings as JSON
- **Import** — Restore data from a previous export file

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/summary` | Aggregate token totals by instance+model |
| `GET /api/current` | Current loaded model per instance |
| `GET /api/models` | List of all known models |
| `GET /api/instances` | List of all instance labels |
| `GET /api/series?range=24h` | Time-series data |
| `GET /api/energy?range=24h&watts={}&rate=0.12` | Energy consumption calculation |
| `GET /api/openrouter-models?q=claude` | Search OpenRouter models |
| `GET /api/cost-calc?model=anthropic/claude-3.5-sonnet&range=24h` | Cost calculation for a model |
| `GET /api/settings` | Get dashboard settings (wattage, rate, cost model) |
| `POST /api/settings` | Save dashboard settings |
| `GET /api/export` | Export all data as JSON |
| `POST /api/import` | Import data from JSON |

## Project Structure

```
llama-monitor/
├── .env.skel              # Example environment variables
├── docker-compose.yml     # Service orchestration
├── .github/workflows/
│   └── docker-publish.yml # GHCR CI/CD automation
├── collector/
│   ├── Dockerfile
│   └── collector.py       # Scraper + SQLite + API + static server
└── frontend/
    ├── index.html         # Dashboard HTML
    ├── style.css          # Gruvbox dark theme
    ├── theme-synthwave.css
    ├── theme-flashbang.css
    ├── theme-doom.css
    └── app.js             # Dashboard logic, no Chart.js
```

## Deployment

### Local Development

```bash
docker compose up -d
```

### Production (GHCR)

The Docker image is automatically built and published to GHCR on each release:

```bash
docker pull ghcr.io/zmail-tech/llama-monitor:latest
```

## Releases

Releases are tagged and published to GitHub:

- **v1.0.0** — Initial release
- **v1.2.0** — Theme support
- **v1.3.0** — GHCR deployment
- **v1.4.0** — Server-side settings persistence
- **v1.6.0** — Removed unused charts, simplified UI
- **v1.7.0** — Cost model persistence
- **v1.8.0** — Data portability (export/import)

## License

MIT
