# codex-telemetry

Standalone telemetry daemon for Codex desktop sessions.

## What it does

- Watches Codex session files under discovered session roots (defaults include `~/.codex/sessions/**/*.jsonl`)
- Parses interactions and tool activity
- Emits telemetry events using schema version `4.0`
- Writes JSONL logs to the same master log path used by the VS Code/Cursor extension by default

## Install

```bash
npm install
npm run compile
```

If you are sharing this package with another Codex user, they can run one file:

```bash
./install-codex-telemetry.sh
```

This script installs dependencies, compiles, installs launchd, and runs a health check.

## Run

```bash
npm run start
```

## Health Check

```bash
npm run health
```

Optional custom log root:

```bash
npm run health -- /path/to/logs
```

This reports:

- Event counts by source
- Schema validity rate
- Recent 24h activity
- Last event timestamp per source

## Configuration

Environment variables:

- `AI_TELEMETRY_LOG_PATH`: base log path (default `~/.ai-telemetry/logs`)
- `AI_TELEMETRY_LOG_MODE`: `shared` (default) or `separate`
- `CODEX_SESSION_ROOT`: explicit Codex session root override
- `CODEX_TELEMETRY_POLL_MS`: polling interval in ms (default `2000`, min `500`)

Session root auto-discovery (when `CODEX_SESSION_ROOT` is not set):

- `~/.codex/sessions`
- `~/Library/Application Support/Codex/sessions`
- `~/Library/Application Support/com.openai.codex/sessions`
- `~/Library/Application Support/com.openai.codex-desktop/sessions`
- `$XDG_DATA_HOME/codex/sessions` (if `XDG_DATA_HOME` is set)

### Shared vs Separate logs

- `shared`: Codex writes into the same master log directory as VS Code/Cursor
- `separate`: Codex writes to `<AI_TELEMETRY_LOG_PATH>/codex`

## Run As macOS launchd Service

Install and start at login:

```bash
npm run launchd:install
```

Uninstall:

```bash
npm run launchd:uninstall
```

Or use the helper script:

```bash
./uninstall-codex-telemetry.sh
```

Service label:

- `com.ai-telemetry.codex`

Service logs:

- `~/.ai-telemetry/daemon/stdout.log`
- `~/.ai-telemetry/daemon/stderr.log`

## Field parity report

From the VS Code/Cursor extension project:

```bash
cd ../ai-telemetry
npm run parity:report
```

Optional custom log directory:

```bash
npm run parity:report -- /path/to/logs
```
