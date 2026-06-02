# telemetry-insights

Lightweight Node CLI that reads `ai-telemetry-v4-YYYY-MM-DD.jsonl` logs and produces a markdown insights report.

## Usage

```bash
npm install
npm run report
```

This generates two outputs:

- Markdown report in `reports/insights-YYYY-MM-DD.md`
- Visual HTML dashboard in `reports/dashboard-YYYY-MM-DD.html`

For non-technical users, run:

```bash
npm run ui
```

Then open `reports/dashboard.html` in any browser.

Dashboard filters available in the UI:

- Start date / End date
- Source
- Assistant client
- Reset filters button

Dashboard insight features:

- Auto-generated findings from the selected scope
- Action recommendations (latency, attribution, reliability, workload mix)
- Insights update live when filters change
- Coaching signals when supported by data (context bloat, too many files touched, mixed-task sessions)
- Blood-report style metric cards with green/yellow/red states and reference boundaries

Optional custom log root:

```bash
npm run report -- /path/to/logs
```

Optional custom report file path:

```bash
npm run report -- /path/to/logs --out ./reports/custom-report.md
```

Optional custom dashboard file path:

```bash
npm run report -- /path/to/logs --ui-out ./reports/custom-dashboard.html
```

## Output

Reports are saved by default to `reports/insights-YYYY-MM-DD.md`.

The report includes:

- Event volume
- Source and assistant split
- Task type breakdown
- Latency summary (avg, p95)
- Token estimates
- Daily trend
