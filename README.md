# AI Telemetry Toolkit

Open-source toolkit for collecting and analyzing AI coding-assistant telemetry from:

- VS Code
- Cursor
- Codex

## Packages

- `ai-telemetry`: VS Code/Cursor extension collector
- `codex-telemetry`: standalone Codex collector daemon
- `telemetry-insights`: lightweight insights CLI over extracted JSONL logs

## Quick Start

### 1) VS Code/Cursor collector

```bash
cd ai-telemetry
npm install
npm run compile
```

### 2) Codex standalone collector

```bash
cd codex-telemetry
./install-codex-telemetry.sh
```

### 3) Insights report

```bash
cd telemetry-insights
npm install
npm run report
```

Non-technical dashboard output:

```bash
cd telemetry-insights
npm run ui
```

Open `telemetry-insights/reports/dashboard.html` in a browser.

## Master Log Strategy

By default, all collectors can write to the same master log root:

- `~/.ai-telemetry/logs`

Each event now carries explicit origin fields for attribution:

- `source` (for example `copilot` or `codex`)
- `assistant_client` (for example `vscode`, `cursor`, `codex`)
- `assistant_name`

## Open Source Readiness

This repository includes:

- `LICENSE` (MIT)
- `CONTRIBUTING.md`
- `CODE_OF_CONDUCT.md`
- `SECURITY.md`
