import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Source = 'copilot' | 'codex' | 'unknown';
type AssistantClient = 'vscode' | 'cursor' | 'codex' | 'unknown';

interface TelemetryEvent {
    schema_version?: string;
    session_id?: string;
    interaction_number?: number;
    source?: Source;
    assistant_client?: AssistantClient;
    assistant_name?: string;
    timestamp?: string;
    task_type?: string;
    prompt_char_length?: number;
    context_files_count?: number;
    files_read?: unknown[];
    idle_ms_since_prev_interaction?: number | null;
    latency_ms?: number;
    tool_success_count?: number;
    tool_failure_count?: number;
    estimated_input_tokens?: number;
    estimated_output_tokens?: number;
}

interface Stats {
    filesScanned: number;
    totalEvents: number;
    malformedLines: number;
    bySource: Record<string, number>;
    byAssistantClient: Record<string, number>;
    byAssistantName: Record<string, number>;
    byTaskType: Record<string, number>;
    bySchema: Record<string, number>;
    dailyEvents: Record<string, number>;
    latencyCount: number;
    latencyTotalMs: number;
    latencyP95Ms: number;
    toolSuccessTotal: number;
    toolFailureTotal: number;
    inputTokensTotal: number;
    outputTokensTotal: number;
}

interface EventRow {
    ts: number;
    day: string;
    sessionId: string;
    interactionNumber: number;
    source: string;
    assistantClient: string;
    assistantName: string;
    taskType: string;
    schema: string;
    promptChars: number;
    contextFilesCount: number;
    filesReadCount: number;
    idleMsSincePrevInteraction: number;
    latencyMs: number;
    toolSuccess: number;
    toolFailure: number;
    inputTokens: number;
    outputTokens: number;
}

interface RankedCount {
    label: string;
    value: number;
}

interface DashboardData {
    generatedAt: string;
    logRoot: string;
    filesScanned: number;
    malformedLines: number;
    events: EventRow[];
}

function main(): void {
    const args = process.argv.slice(2);
    const defaultLogRoot = path.join(os.homedir(), '.ai-telemetry', 'logs');

    let logRoot = defaultLogRoot;
    let markdownOutPath: string | null = null;
    let uiOutPath: string | null = null;

    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--help' || arg === '-h') {
            printHelp();
            return;
        }
        if (arg === '--out') {
            markdownOutPath = args[i + 1] ?? null;
            i += 1;
            continue;
        }
        if (arg === '--ui-out') {
            uiOutPath = args[i + 1] ?? null;
            i += 1;
            continue;
        }
        logRoot = arg;
    }

    const files = findLogFiles(path.resolve(logRoot));
    const { stats, latencies, rows } = buildStats(files);
    stats.latencyP95Ms = percentile(latencies, 95);
    const resolvedLogRoot = path.resolve(logRoot);

    const text = renderMarkdown(stats, resolvedLogRoot);
    process.stdout.write(text + '\n');

    const markdownPath = markdownOutPath
        ? path.resolve(markdownOutPath)
        : path.join(path.resolve(__dirname, '..', 'reports'), `insights-${new Date().toISOString().slice(0, 10)}.md`);

    fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
    fs.writeFileSync(markdownPath, text + '\n', 'utf8');

    const dashboardPath = uiOutPath
        ? path.resolve(uiOutPath)
        : path.join(path.resolve(__dirname, '..', 'reports'), `dashboard-${new Date().toISOString().slice(0, 10)}.html`);

    const dashboardHtml = renderDashboardHtml(buildDashboardData(stats, resolvedLogRoot, rows));
    fs.mkdirSync(path.dirname(dashboardPath), { recursive: true });
    fs.writeFileSync(dashboardPath, dashboardHtml, 'utf8');

    process.stdout.write(`\nSaved markdown report: ${markdownPath}\n`);
    process.stdout.write(`Saved dashboard: ${dashboardPath}\n`);
}

function printHelp(): void {
    process.stdout.write(
        'Usage: npm run report -- [logRoot] [--out reportPath] [--ui-out dashboardPath]\n' +
        'Default logRoot: ~/.ai-telemetry/logs\n'
    );
}

function findLogFiles(root: string): string[] {
    const out: string[] = [];

    const walk = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }
            if (entry.isFile() && /^ai-telemetry-v4-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) {
                out.push(fullPath);
            }
        }
    };

    walk(root);
    out.sort((a, b) => a.localeCompare(b));
    return out;
}

function buildStats(files: string[]): { stats: Stats; latencies: number[]; rows: EventRow[] } {
    const stats: Stats = {
        filesScanned: files.length,
        totalEvents: 0,
        malformedLines: 0,
        bySource: {},
        byAssistantClient: {},
        byAssistantName: {},
        byTaskType: {},
        bySchema: {},
        dailyEvents: {},
        latencyCount: 0,
        latencyTotalMs: 0,
        latencyP95Ms: 0,
        toolSuccessTotal: 0,
        toolFailureTotal: 0,
        inputTokensTotal: 0,
        outputTokensTotal: 0,
    };

    const latencies: number[] = [];
    const rows: EventRow[] = [];

    for (const filePath of files) {
        const raw = fs.readFileSync(filePath, 'utf8');
        for (const line of raw.split('\n')) {
            if (!line.trim()) {
                continue;
            }

            let event: TelemetryEvent;
            try {
                event = JSON.parse(line) as TelemetryEvent;
            } catch {
                stats.malformedLines += 1;
                continue;
            }

            stats.totalEvents += 1;

            const source = event.source ?? 'unknown';
            inc(stats.bySource, source);

            const assistantClient = event.assistant_client ?? 'unknown';
            inc(stats.byAssistantClient, assistantClient);

            const assistantName = normalizeLabel(event.assistant_name ?? 'unknown');
            inc(stats.byAssistantName, assistantName);

            const taskType = normalizeLabel(event.task_type ?? 'other');
            inc(stats.byTaskType, taskType);

            const schema = event.schema_version ?? 'missing';
            inc(stats.bySchema, schema);

            if (typeof event.timestamp === 'string' && event.timestamp.length >= 10) {
                const day = event.timestamp.slice(0, 10);
                inc(stats.dailyEvents, day);
            }

            if (typeof event.latency_ms === 'number' && Number.isFinite(event.latency_ms)) {
                stats.latencyCount += 1;
                stats.latencyTotalMs += event.latency_ms;
                latencies.push(event.latency_ms);
            }

            stats.toolFailureTotal += asNumber(event.tool_failure_count);

            rows.push({
                ts: typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : Date.now(),
                day: typeof event.timestamp === 'string' && event.timestamp.length >= 10 ? event.timestamp.slice(0, 10) : 'unknown',
                sessionId: event.session_id ?? 'unknown',
                interactionNumber: typeof event.interaction_number === 'number' ? event.interaction_number : 0,
                source,
                assistantClient,
                assistantName,
                taskType,
                schema,
                promptChars: asNumber(event.prompt_char_length),
                contextFilesCount: asNumber(event.context_files_count),
                filesReadCount: Array.isArray(event.files_read) ? event.files_read.length : 0,
                idleMsSincePrevInteraction: asNumber(event.idle_ms_since_prev_interaction),
                latencyMs: asNumber(event.latency_ms),
                toolSuccess: asNumber(event.tool_success_count),
                toolFailure: asNumber(event.tool_failure_count),
                inputTokens: asNumber(event.estimated_input_tokens),
                outputTokens: asNumber(event.estimated_output_tokens),
            });
        }
    }

    return { stats, latencies, rows };
}

function renderMarkdown(stats: Stats, logRoot: string): string {
    const lines: string[] = [];

    lines.push('# Telemetry Insights');
    lines.push('');
    lines.push(`- Generated at: ${new Date().toISOString()}`);
    lines.push(`- Log root: ${logRoot}`);
    lines.push(`- Files scanned: ${stats.filesScanned}`);
    lines.push(`- Total events: ${stats.totalEvents}`);
    lines.push(`- Malformed lines: ${stats.malformedLines}`);
    lines.push('');

    lines.push('## Core Metrics');
    lines.push('');
    lines.push(`- Avg latency (ms): ${formatNumber(avg(stats.latencyTotalMs, stats.latencyCount))}`);
    lines.push(`- P95 latency (ms): ${formatNumber(stats.latencyP95Ms)}`);
    lines.push(`- Tool success total: ${stats.toolSuccessTotal}`);
    lines.push(`- Tool failure total: ${stats.toolFailureTotal}`);
    lines.push(`- Estimated input tokens total: ${stats.inputTokensTotal}`);
    lines.push(`- Estimated output tokens total: ${stats.outputTokensTotal}`);
    lines.push('');

    lines.push('## Events by Source');
    lines.push('');
    lines.push(...toBulletLines(stats.bySource));
    lines.push('');

    lines.push('## Events by Assistant Client');
    lines.push('');
    lines.push(...toBulletLines(stats.byAssistantClient));
    lines.push('');

    lines.push('## Events by Assistant Name');
    lines.push('');
    lines.push(...toBulletLines(stats.byAssistantName));
    lines.push('');

    lines.push('## Events by Task Type');
    lines.push('');
    lines.push(...toBulletLines(stats.byTaskType));
    lines.push('');

    lines.push('## Events by Schema Version');
    lines.push('');
    lines.push(...toBulletLines(stats.bySchema));
    lines.push('');

    lines.push('## Daily Event Volume');
    lines.push('');
    lines.push(...toBulletLines(stats.dailyEvents));

    return lines.join('\n');
}

function buildDashboardData(stats: Stats, logRoot: string, rows: EventRow[]): DashboardData {
        return {
                generatedAt: new Date().toISOString(),
                logRoot,
        filesScanned: stats.filesScanned,
        malformedLines: stats.malformedLines,
        events: rows,
        };
}

function ranked(counts: Record<string, number>): RankedCount[] {
        return Object.entries(counts)
                .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                .map(([label, value]) => ({ label, value }));
}

function renderDashboardHtml(data: DashboardData): string {
        const payload = JSON.stringify(data)
                .replace(/</g, '\\u003c')
                .replace(/>/g, '\\u003e');

        return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Telemetry Insights Dashboard</title>
    <style>
        :root {
            --bg: #f6f8fb;
            --panel: #ffffff;
            --ink: #1f2937;
            --ink-soft: #475569;
            --line: #dbe3ef;
            --brand: #0f766e;
            --brand-soft: #99f6e4;
            --warn: #b45309;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Avenir Next", "Segoe UI", sans-serif;
            color: var(--ink);
            background:
                radial-gradient(circle at 20% -10%, #d1fae5 0, transparent 35%),
                radial-gradient(circle at 90% -10%, #dbeafe 0, transparent 30%),
                var(--bg);
        }
        .wrap {
            max-width: 1200px;
            margin: 0 auto;
            padding: 28px 16px 36px;
        }
        h1 {
            margin: 0 0 8px;
            font-size: clamp(1.5rem, 2vw + 1rem, 2.25rem);
            letter-spacing: 0.2px;
        }
        .meta {
            color: var(--ink-soft);
            margin-bottom: 20px;
            line-height: 1.4;
            font-size: 0.95rem;
        }
        .grid {
            display: grid;
            gap: 12px;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            margin-bottom: 18px;
        }
        .metric-legend {
            display: flex;
            gap: 10px;
            flex-wrap: wrap;
            margin-bottom: 12px;
            color: var(--ink-soft);
            font-size: 0.82rem;
        }
        .metric-legend span {
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .card {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 12px;
            padding: 12px;
            box-shadow: 0 1px 2px rgba(2, 6, 23, 0.05);
        }
        .metric-card {
            display: grid;
            gap: 8px;
            min-height: 138px;
        }
        .metric-head {
            display: flex;
            justify-content: space-between;
            gap: 8px;
            align-items: flex-start;
        }
        .metric-title {
            margin: 0;
            font-size: 0.9rem;
            color: var(--ink-soft);
            font-weight: 700;
            line-height: 1.25;
        }
        .metric-value {
            font-size: clamp(1.25rem, 1.2vw + 0.8rem, 1.75rem);
            font-weight: 800;
            line-height: 1.1;
        }
        .metric-boundary {
            color: var(--ink-soft);
            font-size: 0.8rem;
            line-height: 1.35;
        }
        .metric-note {
            font-size: 0.82rem;
            line-height: 1.35;
            color: var(--ink);
        }
        .metric-pill {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 4px 8px;
            border-radius: 999px;
            font-size: 0.72rem;
            font-weight: 800;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            white-space: nowrap;
        }
        .metric-pill.green { background: #dcfce7; color: #166534; }
        .metric-pill.yellow { background: #fef3c7; color: #92400e; }
        .metric-pill.red { background: #fee2e2; color: #991b1b; }
        .metric-dot {
            width: 9px;
            height: 9px;
            border-radius: 999px;
            display: inline-block;
        }
        .metric-dot.green { background: #16a34a; }
        .metric-dot.yellow { background: #d97706; }
        .metric-dot.red { background: #dc2626; }
        .metric-healthy { border-left: 5px solid #16a34a; }
        .metric-watch { border-left: 5px solid #d97706; }
        .metric-action { border-left: 5px solid #dc2626; }
        .metric-state-strip {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 10px;
            margin-bottom: 18px;
        }
        .metric-state-card {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 12px;
            padding: 10px 12px;
            cursor: pointer;
            transition: transform 0.15s ease, box-shadow 0.15s ease;
        }
        .metric-state-card:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 14px rgba(2, 6, 23, 0.08);
        }
        .metric-state-card .label {
            display: block;
            font-size: 0.78rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: var(--ink-soft);
            margin-bottom: 6px;
        }
        .metric-state-card .value {
            font-size: 1rem;
            font-weight: 800;
        }
        .drilldown {
            margin-top: 18px;
            background: rgba(255, 255, 255, 0.75);
            border: 1px solid var(--line);
            border-radius: 16px;
            padding: 14px;
            backdrop-filter: blur(8px);
        }
        .drilldown-head {
            display: flex;
            justify-content: space-between;
            gap: 12px;
            align-items: center;
            flex-wrap: wrap;
            margin-bottom: 10px;
        }
        .drilldown-head h2 {
            margin: 0;
            font-size: 1.05rem;
        }
        .drilldown-tabs {
            display: flex;
            flex-wrap: wrap;
            gap: 8px;
            margin-bottom: 12px;
        }
        .drilldown-tab {
            border: 1px solid var(--line);
            background: #fff;
            color: var(--ink-soft);
            border-radius: 999px;
            padding: 8px 12px;
            font: inherit;
            cursor: pointer;
        }
        .drilldown-tab.active {
            background: var(--brand);
            color: #fff;
            border-color: var(--brand);
        }
        .drilldown-toolbar {
            display: grid;
            grid-template-columns: repeat(4, minmax(0, 1fr));
            gap: 10px;
            margin-bottom: 12px;
        }
        .drilldown-toolbar label {
            display: grid;
            gap: 6px;
            font-size: 0.82rem;
            color: var(--ink-soft);
        }
        .drilldown-toolbar input,
        .drilldown-toolbar select,
        .drilldown-toolbar button {
            border: 1px solid var(--line);
            border-radius: 10px;
            padding: 8px 10px;
            font: inherit;
            background: #fff;
            color: var(--ink);
        }
        .drilldown-toolbar button {
            cursor: pointer;
            background: #eefbf7;
        }
        .drilldown-grid {
            display: grid;
            grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
            gap: 12px;
        }
        .drilldown-panel {
            background: #fff;
            border: 1px solid var(--line);
            border-radius: 14px;
            padding: 12px;
        }
        .drilldown-panel h3 {
            margin: 0 0 10px;
            font-size: 0.98rem;
        }
        .pareto-list {
            display: grid;
            gap: 10px;
        }
        .pareto-row {
            display: grid;
            grid-template-columns: minmax(100px, 1fr) minmax(140px, 3fr) auto;
            gap: 10px;
            align-items: center;
            font-size: 0.9rem;
        }
        .pareto-bar {
            width: 100%;
            height: 12px;
            background: #eef2f7;
            border-radius: 999px;
            overflow: hidden;
            border: 1px solid #e2e8f0;
        }
        .pareto-fill {
            height: 100%;
            background: linear-gradient(90deg, var(--brand), #14b8a6);
        }
        .drilldown-summary {
            display: grid;
            gap: 8px;
            font-size: 0.92rem;
            color: var(--ink-soft);
        }
        .drilldown-summary strong {
            color: var(--ink);
        }
        .chip {
            font-size: 0.82rem;
            color: var(--ink-soft);
            margin-bottom: 10px;
        }
        @media (max-width: 980px) {
            .grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .metric-state-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .drilldown-toolbar { grid-template-columns: repeat(2, minmax(0, 1fr)); }
            .drilldown-grid { grid-template-columns: 1fr; }
        }
        @media (max-width: 560px) {
            .grid { grid-template-columns: 1fr; }
            .metric-state-strip { grid-template-columns: 1fr; }
            .drilldown-toolbar { grid-template-columns: 1fr; }
            .pareto-row { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="wrap">
        <h1>Telemetry Insights Dashboard</h1>
        <div class="meta" id="meta"></div>

        <section class="metric-state-strip" id="metricStateStrip"></section>

        <section class="drilldown" aria-label="Metric drilldown">
            <div class="drilldown-head">
                <h2>Metric drilldown</h2>
                <div class="chip" id="drilldownScope"></div>
            </div>
            <div class="drilldown-tabs" id="drilldownTabs"></div>
            <div class="drilldown-toolbar">
                <label>
                    Start date
                    <input type="date" id="drilldownStartDate" />
                </label>
                <label>
                    End date
                    <input type="date" id="drilldownEndDate" />
                </label>
                <label>
                    Source
                    <select id="drilldownSource"></select>
                </label>
                <label>
                    Assistant client
                    <select id="drilldownClient"></select>
                </label>
            </div>
            <div class="drilldown-grid">
                <article class="drilldown-panel">
                    <h3>What this tab is showing</h3>
                    <div class="drilldown-summary" id="drilldownSummary"></div>
                </article>
                <article class="drilldown-panel">
                    <h3>Pareto breakdown</h3>
                    <div class="pareto-list" id="paretoList"></div>
                </article>
            </div>
        </section>
    </div>

    <script>
        const data = ${payload};
        const rawEvents = Array.isArray(data.events) ? data.events : [];

        const fmt = new Intl.NumberFormat();
        const one = (n) => Number.isFinite(n) ? n.toFixed(1) : '0.0';
        const byCount = (map) => Object.entries(map).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, value]) => ({ label, value }));
        const severityWeight = { green: 0, yellow: 1, red: 2 };
        const metricKeys = [
            'attribution',
            'latency',
            'contextAverage',
            'promptP90',
            'filesTouched',
            'contextFiles',
            'multiTask',
            'toolFailure',
            'taskConcentration',
            'trend',
        ];

        const summarize = (events) => {
            const out = {
                totalEvents: events.length,
                bySource: {},
                byAssistantClient: {},
                byAssistantName: {},
                byTaskType: {},
                bySchema: {},
                dailyEvents: {},
                latencyValues: [],
                promptCharsValues: [],
                contextFilesValues: [],
                filesReadValues: [],
                idleValues: [],
                toolSuccessTotal: 0,
                toolFailureTotal: 0,
                inputTokensTotal: 0,
                outputTokensTotal: 0,
                sessionTaskMap: new Map(),
            };

            events.forEach(e => {
                const source = e.source || 'unknown';
                const client = e.assistantClient || 'unknown';
                const name = e.assistantName || 'unknown';
                const task = e.taskType || 'other';
                const schema = e.schema || 'missing';
                const day = e.day || 'unknown';

                out.bySource[source] = (out.bySource[source] || 0) + 1;
                out.byAssistantClient[client] = (out.byAssistantClient[client] || 0) + 1;
                out.byAssistantName[name] = (out.byAssistantName[name] || 0) + 1;
                out.byTaskType[task] = (out.byTaskType[task] || 0) + 1;
                out.bySchema[schema] = (out.bySchema[schema] || 0) + 1;
                out.dailyEvents[day] = (out.dailyEvents[day] || 0) + 1;

                if (Number.isFinite(e.latencyMs) && e.latencyMs > 0) {
                    out.latencyValues.push(e.latencyMs);
                }
                if (Number.isFinite(e.promptChars) && e.promptChars > 0) {
                    out.promptCharsValues.push(e.promptChars);
                }
                if (Number.isFinite(e.contextFilesCount) && e.contextFilesCount >= 0) {
                    out.contextFilesValues.push(e.contextFilesCount);
                }
                if (Number.isFinite(e.filesReadCount) && e.filesReadCount >= 0) {
                    out.filesReadValues.push(e.filesReadCount);
                }
                if (Number.isFinite(e.idleMsSincePrevInteraction) && e.idleMsSincePrevInteraction > 0) {
                    out.idleValues.push(e.idleMsSincePrevInteraction);
                }
                out.toolSuccessTotal += Number.isFinite(e.toolSuccess) ? e.toolSuccess : 0;
                out.toolFailureTotal += Number.isFinite(e.toolFailure) ? e.toolFailure : 0;
                out.inputTokensTotal += Number.isFinite(e.inputTokens) ? e.inputTokens : 0;
                out.outputTokensTotal += Number.isFinite(e.outputTokens) ? e.outputTokens : 0;

                const session = e.sessionId || 'unknown';
                const current = out.sessionTaskMap.get(session) || new Set();
                current.add(task);
                out.sessionTaskMap.set(session, current);
            });

            out.latencyValues.sort((a, b) => a - b);
            out.promptCharsValues.sort((a, b) => a - b);
            out.contextFilesValues.sort((a, b) => a - b);
            out.filesReadValues.sort((a, b) => a - b);
            out.idleValues.sort((a, b) => a - b);
            const latencyAvg = out.latencyValues.length === 0
                ? 0
                : out.latencyValues.reduce((s, n) => s + n, 0) / out.latencyValues.length;
            const p95Idx = out.latencyValues.length === 0
                ? 0
                : Math.min(out.latencyValues.length - 1, Math.max(0, Math.ceil(0.95 * out.latencyValues.length) - 1));
            const latencyP95 = out.latencyValues.length === 0 ? 0 : out.latencyValues[p95Idx];

            const percentileSorted = (arr, p) => {
                if (!arr || arr.length === 0) {
                    return 0;
                }
                const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
                return arr[idx];
            };

            const sessions = Array.from(out.sessionTaskMap.keys()).filter(s => s !== 'unknown');
            const sessionsWithMultipleTaskTypes = sessions.filter(s => (out.sessionTaskMap.get(s)?.size || 0) > 1).length;
            const multiTaskSessionShare = sessions.length > 0 ? sessionsWithMultipleTaskTypes / sessions.length : 0;
            let avgTaskTypesPerSession = 0;
            if (sessions.length > 0) {
                avgTaskTypesPerSession = sessions
                    .map(s => out.sessionTaskMap.get(s)?.size || 0)
                    .reduce((sum, n) => sum + n, 0) / sessions.length;
            }

            return {
                ...out,
                latencyAvg,
                latencyP95,
                avgInputTokensPerEvent: out.totalEvents > 0 ? out.inputTokensTotal / out.totalEvents : 0,
                p90InputTokens: percentileSorted(out.inputTokensTotal > 0 ? events.map(e => e.inputTokens).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b) : [], 90),
                avgPromptCharsPerEvent: out.promptCharsValues.length > 0 ? out.promptCharsValues.reduce((s, n) => s + n, 0) / out.promptCharsValues.length : 0,
                p90PromptChars: percentileSorted(out.promptCharsValues, 90),
                avgContextFilesPerEvent: out.contextFilesValues.length > 0 ? out.contextFilesValues.reduce((s, n) => s + n, 0) / out.contextFilesValues.length : 0,
                p90ContextFiles: percentileSorted(out.contextFilesValues, 90),
                avgFilesReadPerEvent: out.filesReadValues.length > 0 ? out.filesReadValues.reduce((s, n) => s + n, 0) / out.filesReadValues.length : 0,
                p90FilesRead: percentileSorted(out.filesReadValues, 90),
                medianIdleMs: percentileSorted(out.idleValues, 50),
                sessionsCount: sessions.length,
                multiTaskSessionShare,
                avgTaskTypesPerSession,
                top: {
                    source: byCount(out.bySource),
                    assistantClient: byCount(out.byAssistantClient),
                    assistantName: byCount(out.byAssistantName),
                    taskType: byCount(out.byTaskType),
                    dailyEvents: byCount(out.dailyEvents),
                    schema: byCount(out.bySchema),
                }
            };
        };

        const addInsight = (list, text) => {
            if (text && !list.some(x => x.text === text.text && x.severity === text.severity)) {
                list.push(text);
            }
        };

        const highestSeverity = (items) => {
            if (!items || items.length === 0) {
                return 'green';
            }
            return items.reduce((current, item) => {
                return severityWeight[item.severity] > severityWeight[current] ? item.severity : current;
            }, 'green');
        };

        const stateLabel = (severity) => {
            if (severity === 'red') return 'Needs Attention';
            if (severity === 'yellow') return 'Watch';
            return 'Healthy';
        };

        const metricStateLabel = (severity) => {
            if (severity === 'red') return 'Critical';
            if (severity === 'yellow') return 'Borderline';
            return 'Normal';
        };

        const metricBadge = (severity) => {
            return '<span class="metric-pill ' + severity + '"><i class="metric-dot ' + severity + '"></i>' + metricStateLabel(severity) + '</span>';
        };

        const makeMetricCard = (title, value, severity, boundary, note) => {
            return {
                title,
                value,
                severity,
                boundary,
                note,
            };
        };

        const calcSeverity = (value, greenMax, yellowMax, reverse = false) => {
            if (reverse) {
                if (value >= greenMax) return 'green';
                if (value >= yellowMax) return 'yellow';
                return 'red';
            }
            if (value <= greenMax) return 'green';
            if (value <= yellowMax) return 'yellow';
            return 'red';
        };

        const distinctValues = (events, field) => {
            const set = new Set();
            events.forEach(event => set.add((event[field] || 'unknown').toString()));
            return Array.from(set).sort((a, b) => a.localeCompare(b));
        };

        const dayToNumber = (day) => {
            if (!day || day === 'unknown') return NaN;
            const ts = Date.parse(day + 'T00:00:00Z');
            return Number.isFinite(ts) ? ts : NaN;
        };

        const applyDrilldownFilters = (events) => {
            const startValue = document.getElementById('drilldownStartDate').value;
            const endValue = document.getElementById('drilldownEndDate').value;
            const sourceValue = document.getElementById('drilldownSource').value;
            const clientValue = document.getElementById('drilldownClient').value;
            const startNum = startValue ? dayToNumber(startValue) : NaN;
            const endNum = endValue ? dayToNumber(endValue) : NaN;

            return events.filter(event => {
                if (sourceValue !== 'all' && (event.source || 'unknown') !== sourceValue) return false;
                if (clientValue !== 'all' && (event.assistantClient || 'unknown') !== clientValue) return false;
                if (startValue || endValue) {
                    const dayNum = dayToNumber(event.day);
                    if (!Number.isFinite(dayNum)) return false;
                    if (Number.isFinite(startNum) && dayNum < startNum) return false;
                    if (Number.isFinite(endNum) && dayNum > endNum) return false;
                }
                return true;
            });
        };

        const buildParetoRows = (events, accessor, labeler, limit = 8) => {
            const counts = new Map();
            events.forEach(event => {
                const key = labeler(accessor(event), event);
                counts.set(key, (counts.get(key) || 0) + 1);
            });
            return Array.from(counts.entries())
                .map(([label, value]) => ({ label, value }))
                .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
                .slice(0, limit);
        };

        const buildMetricDetail = (metric, events) => {
            const total = events.length;
            const sourceCounts = byCount(events.reduce((map, event) => {
                map[event.source || 'unknown'] = (map[event.source || 'unknown'] || 0) + 1;
                return map;
            }, {}));
            const clientCounts = byCount(events.reduce((map, event) => {
                map[event.assistantClient || 'unknown'] = (map[event.assistantClient || 'unknown'] || 0) + 1;
                return map;
            }, {}));

            switch (metric) {
                case 'attribution':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> whether events can be linked back to a named assistant or client.',
                            '<strong>Why this matters:</strong> unknown events make the log hard to compare across VS Code, Cursor, and Codex.',
                        ],
                        rows: buildParetoRows(events, event => event.source || 'unknown', value => value, 8),
                        axisLabel: 'Events by source/client',
                    };
                case 'latency':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> the slowest 5% of interactions in the current scope.',
                            '<strong>Why this matters:</strong> high tail latency means some requests are still too slow even if the average looks fine.',
                        ],
                        rows: events
                            .filter(event => Number.isFinite(event.latencyMs) && event.latencyMs > 0)
                            .sort((a, b) => b.latencyMs - a.latencyMs)
                            .slice(0, 8)
                            .map(event => ({ label: event.day + ' · ' + event.taskType, value: event.latencyMs, suffix: 'ms' })),
                        axisLabel: 'Slowest events',
                    };
                case 'contextAverage':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> how much context is being carried into each call on average.',
                            '<strong>Why this matters:</strong> large context usually means a chat is being kept alive too long instead of starting a fresh task.',
                        ],
                        rows: events
                            .filter(event => Number.isFinite(event.inputTokens) && event.inputTokens > 0)
                            .sort((a, b) => b.inputTokens - a.inputTokens)
                            .slice(0, 8)
                            .map(event => ({ label: event.day + ' · ' + event.taskType, value: event.inputTokens, suffix: 'tokens' })),
                        axisLabel: 'Largest context events',
                    };
                case 'promptP90':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> the size of the heaviest prompts in the top 10% of calls.',
                            '<strong>Why this matters:</strong> very large prompts often mean the same chat is carrying too much history into a request.',
                        ],
                        rows: events
                            .filter(event => Number.isFinite(event.promptChars) && event.promptChars > 0)
                            .sort((a, b) => b.promptChars - a.promptChars)
                            .slice(0, 8)
                            .map(event => ({ label: event.day + ' · ' + event.taskType, value: event.promptChars, suffix: 'chars' })),
                        axisLabel: 'Longest prompts',
                    };
                case 'filesTouched':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> how many files the AI response touches in the busiest 10% of work.',
                            '<strong>Why this matters:</strong> too many files usually means the task is not small enough and the assistant is spreading too wide.',
                        ],
                        rows: events
                            .filter(event => Number.isFinite(event.filesReadCount) && event.filesReadCount > 0)
                            .sort((a, b) => b.filesReadCount - a.filesReadCount)
                            .slice(0, 8)
                            .map(event => ({ label: event.day + ' · ' + event.taskType, value: event.filesReadCount, suffix: 'files' })),
                        axisLabel: 'Most file-heavy events',
                    };
                case 'contextFiles':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> how many supporting files were attached or included in heavy calls.',
                            '<strong>Why this matters:</strong> too many context files usually means the request is too broad and should be split up.',
                        ],
                        rows: events
                            .filter(event => Number.isFinite(event.contextFilesCount) && event.contextFilesCount > 0)
                            .sort((a, b) => b.contextFilesCount - a.contextFilesCount)
                            .slice(0, 8)
                            .map(event => ({ label: event.day + ' · ' + event.taskType, value: event.contextFilesCount, suffix: 'files' })),
                        axisLabel: 'Most context-heavy events',
                    };
                case 'multiTask':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> how often one conversation mixes several different task types.',
                            '<strong>Why this matters:</strong> mixed tasks make chats harder to keep focused, so separate conversations are usually cleaner.',
                        ],
                        rows: buildParetoRows(events, event => event.sessionId || 'unknown', value => value, 8),
                        axisLabel: 'Events by session',
                    };
                case 'toolFailure':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> how often tool calls fail in the selected scope.',
                            '<strong>Why this matters:</strong> repeated failures usually mean the workflow or task shape is forcing brittle steps.',
                        ],
                        rows: events
                            .filter(event => Number.isFinite(event.toolFailure) && event.toolFailure > 0)
                            .sort((a, b) => b.toolFailure - a.toolFailure)
                            .slice(0, 8)
                            .map(event => ({ label: event.day + ' · ' + event.taskType, value: event.toolFailure, suffix: 'failures' })),
                        axisLabel: 'Failing events',
                    };
                case 'taskConcentration':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> whether one task type dominates the conversation.',
                            '<strong>Why this matters:</strong> very high concentration can mean the chat is carrying too much unrelated work instead of staying focused.',
                        ],
                        rows: buildParetoRows(events, event => event.taskType || 'other', value => value, 8),
                        axisLabel: 'Events by task type',
                    };
                case 'trend':
                    return {
                        summary: [
                            '<strong>What it measures:</strong> whether activity is rising or falling over time.',
                            '<strong>Why this matters:</strong> a sharp drop can mean the workflow is slowing down, while a sharp rise can mean more work is being pushed through the same pattern.',
                        ],
                        rows: buildParetoRows(events, event => event.day || 'unknown', value => value, 8),
                        axisLabel: 'Events by day',
                    };
                default:
                    return { summary: [], rows: [], axisLabel: 'Events' };
            }
        };

        const renderDetail = (metric, events) => {
            const detail = buildMetricDetail(metric, events);
            const summaryEl = document.getElementById('drilldownSummary');
            const paretoEl = document.getElementById('paretoList');
            const scopeEl = document.getElementById('drilldownScope');
            const titleMap = {
                attribution: 'Attribution coverage',
                latency: 'P95 latency',
                contextAverage: 'Average context size',
                promptP90: 'Prompt size P90',
                filesTouched: 'Files touched P90',
                contextFiles: 'Context files P90',
                multiTask: 'Multi-task session mix',
                toolFailure: 'Tool failure rate',
                taskConcentration: 'Task concentration',
                trend: 'Activity trend',
            };

            scopeEl.textContent = titleMap[metric] || 'Metric detail';
            summaryEl.innerHTML = detail.summary.join('<br />');
            if (!detail.rows.length) {
                paretoEl.innerHTML = '<div class="empty">No rows for the current filters.</div>';
                return;
            }

            const total = detail.rows.reduce((sum, row) => sum + (Number.isFinite(row.value) ? row.value : 0), 0) || detail.rows.reduce((sum) => sum + 1, 0);
            paretoEl.innerHTML = '';
            detail.rows.forEach((row, index) => {
                const value = Number.isFinite(row.value) ? row.value : 0;
                const width = Math.max(6, Math.round((value / Math.max(1, detail.rows[0].value || value || 1)) * 100));
                const item = document.createElement('div');
                item.className = 'pareto-row';
                item.innerHTML =
                    '<div class="label" title="' + row.label + '">' + (index + 1) + '. ' + row.label + '</div>' +
                    '<div class="pareto-bar"><div class="pareto-fill" style="width:' + width + '%"></div></div>' +
                    '<div class="value">' + fmt.format(value) + (row.suffix ? ' ' + row.suffix : '') + '</div>';
                paretoEl.appendChild(item);
            });
        };

        const populateSelect = (el, values) => {
            el.innerHTML = '';
            const all = document.createElement('option');
            all.value = 'all';
            all.textContent = 'All';
            el.appendChild(all);
            values.forEach(value => {
                const option = document.createElement('option');
                option.value = value;
                option.textContent = value;
                el.appendChild(option);
            });
            el.value = 'all';
        };

        const renderTabs = (events, activeMetric) => {
            const tabsEl = document.getElementById('drilldownTabs');
            tabsEl.innerHTML = '';
            const labels = {
                attribution: 'Attribution',
                latency: 'Latency',
                contextAverage: 'Context',
                promptP90: 'Prompt size',
                filesTouched: 'Files touched',
                contextFiles: 'Context files',
                multiTask: 'Multi-task',
                toolFailure: 'Tool failures',
                taskConcentration: 'Task concentration',
                trend: 'Trend',
            };
            metricKeys.forEach(metric => {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'drilldown-tab' + (metric === activeMetric ? ' active' : '');
                button.textContent = labels[metric] || metric;
                button.addEventListener('click', () => {
                    state.activeMetric = metric;
                    renderDrilldown();
                });
                tabsEl.appendChild(button);
            });
        };

        const state = {
            activeMetric: 'filesTouched',
        };

        const renderDrilldown = () => {
            const filtered = applyDrilldownFilters(rawEvents);
            renderTabs(filtered, state.activeMetric);
            renderDetail(state.activeMetric, filtered);
            const startValue = document.getElementById('drilldownStartDate').value || 'any';
            const endValue = document.getElementById('drilldownEndDate').value || 'any';
            const sourceValue = document.getElementById('drilldownSource').value || 'all';
            const clientValue = document.getElementById('drilldownClient').value || 'all';
            document.getElementById('drilldownScope').textContent =
                'Scope: ' + filtered.length + ' events | source=' + sourceValue + ' | client=' + clientValue + ' | date=' + startValue + ' to ' + endValue;
        };

        const computeInsights = (summary) => {
            const findings = [];
            const actions = [];

            const total = summary.totalEvents || 0;
            if (total === 0) {
                findings.push({ severity: 'yellow', text: 'No events in the current filter scope, so there is no activity to analyze yet.' });
                actions.push({ severity: 'yellow', text: 'Widen the date range or reset filters to include more events.' });
                return { findings, actions };
            }

            const unknownSource = summary.bySource.unknown || 0;
            const unknownClient = summary.byAssistantClient.unknown || 0;
            const unknownShare = Math.max(unknownSource / total, unknownClient / total);
            if (unknownShare >= 0.7) {
                addInsight(findings, { severity: 'red', text: 'Most events are not attributed to a named assistant source/client yet.' });
                addInsight(actions, { severity: 'red', text: 'Roll out the latest collectors so new events populate source and assistant_client fields.' });
            } else {
                const sources = nonUnknownKeys(summary.bySource).length;
                addInsight(findings, { severity: 'green', text: 'Attribution coverage is healthy with identifiable assistant source labels.' });
                if (sources <= 1) {
                    addInsight(actions, { severity: 'yellow', text: 'Add at least one more assistant integration to compare productivity patterns across tools.' });
                }
            }

            if (summary.latencyP95 >= 15000) {
                addInsight(findings, { severity: 'red', text: 'High tail latency detected: p95 response time exceeds 15 seconds.' });
                addInsight(actions, { severity: 'red', text: 'Review heavy prompts/tool chains and prioritize reducing long-running interactions.' });
            } else if (summary.latencyP95 > 0) {
                addInsight(findings, { severity: 'green', text: 'Response latency is within a manageable range for most interactions.' });
            }

            if (total >= 10) {
                if (summary.p90InputTokens >= 2500 || summary.p90PromptChars >= 9000) {
                    addInsight(findings, { severity: 'red', text: 'Large context payloads are frequently sent in requests (top 10% are very heavy).' });
                    addInsight(actions, { severity: 'red', text: 'Trim prompts and context to only task-relevant files; move background notes to separate chats.' });
                } else if (summary.avgInputTokensPerEvent >= 1200) {
                    addInsight(findings, { severity: 'yellow', text: 'Average context size is moderately high across interactions.' });
                    addInsight(actions, { severity: 'yellow', text: 'Use short task briefs and include only the minimum file set needed for each request.' });
                }

                if (summary.p90FilesRead >= 12 || summary.avgFilesReadPerEvent >= 6 || summary.p90ContextFiles >= 8) {
                    addInsight(findings, { severity: 'red', text: 'Many interactions touch a broad set of files, which can dilute task focus.' });
                    addInsight(actions, { severity: 'red', text: 'Break updates into smaller scoped tasks with a tighter file boundary per interaction.' });
                }

                if (summary.sessionsCount >= 5 && summary.multiTaskSessionShare >= 0.45 && summary.avgTaskTypesPerSession >= 2.0) {
                    addInsight(findings, { severity: 'red', text: 'A large share of sessions mix multiple task types in the same chat thread.' });
                    addInsight(actions, { severity: 'red', text: 'Start a new chat for each distinct task to improve context quality and reduce cross-task drift.' });
                }

                if (summary.top.taskType.length > 0) {
                    const largest = summary.top.taskType[0];
                    const largestShare = largest.value / total;
                    if (largestShare < 0.4 && summary.top.taskType.length >= 4) {
                        addInsight(findings, { severity: 'yellow', text: 'Task intent appears fragmented across many categories in the same analysis window.' });
                        addInsight(actions, { severity: 'yellow', text: 'Define one clear objective per interaction and defer side requests to follow-up tasks.' });
                    }
                }
            }

            const totalToolOps = summary.toolSuccessTotal + summary.toolFailureTotal;
            const failureRate = totalToolOps > 0 ? summary.toolFailureTotal / totalToolOps : 0;
            if (failureRate >= 0.1) {
                addInsight(findings, { severity: 'red', text: 'Tool reliability needs attention: tool failure rate is above 10%.' });
                addInsight(actions, { severity: 'red', text: 'Inspect failing tool calls first and add retries or guardrails for common failure paths.' });
            } else if (totalToolOps > 0) {
                addInsight(findings, { severity: 'green', text: 'Tool executions are mostly successful in this scope.' });
            }

            const topTask = summary.top.taskType[0];
            if (topTask && total > 0) {
                const taskShare = topTask.value / total;
                if (taskShare >= 0.6) {
                    addInsight(findings, { severity: 'yellow', text: 'Workload is concentrated in one task type: ' + topTask.label + '.' });
                    addInsight(actions, { severity: 'yellow', text: 'Consider balancing workflow with dedicated review/testing blocks to reduce task monoculture.' });
                }
            }

            const daily = summary.top.dailyEvents
                .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.label))
                .sort((a, b) => a.label.localeCompare(b.label));
            if (daily.length >= 4) {
                const split = Math.floor(daily.length / 2);
                const early = daily.slice(0, split);
                const recent = daily.slice(split);
                const earlyAvg = early.reduce((s, x) => s + x.value, 0) / Math.max(1, early.length);
                const recentAvg = recent.reduce((s, x) => s + x.value, 0) / Math.max(1, recent.length);
                if (recentAvg >= earlyAvg * 1.25) {
                    addInsight(findings, { severity: 'green', text: 'Interaction volume is trending up versus the earlier period.' });
                    addInsight(actions, { severity: 'green', text: 'Track whether increased volume also improves outcomes (latency, failures, task completion).' });
                } else if (recentAvg <= earlyAvg * 0.75) {
                    addInsight(findings, { severity: 'yellow', text: 'Interaction volume is trending down compared to the earlier period.' });
                    addInsight(actions, { severity: 'yellow', text: 'Validate whether lower volume reflects efficiency gains or reduced assistant usage.' });
                }
            }

            if (actions.length === 0) {
                actions.push({ severity: 'green', text: 'Current metrics look stable. Continue monitoring trends weekly with the same filters.' });
            }

            return { findings, actions };
        };

        const renderMetricCards = (summary) => {
            const cards = [
                makeMetricCard(
                    'This event came from a known assistant',
                    fmt.format(Math.round((1 - Math.max(summary.bySource.unknown || 0, summary.byAssistantClient.unknown || 0) / Math.max(1, summary.totalEvents)) * 100)) + '% identified',
                    calcSeverity(Math.max(summary.bySource.unknown || 0, summary.byAssistantClient.unknown || 0) / Math.max(1, summary.totalEvents), 0.3, 0.7, true),
                    'Reference: > 70% identified, 30-70% watch, < 30% red',
                    'What it measures: whether each event can be tied to a specific assistant or client. Why it matters: if too many events are unknown, the log is too blurry to compare VS Code, Cursor, and Codex fairly.'
                ),
                makeMetricCard(
                    'Some responses are taking longer than they should',
                    one(summary.latencyP95) + ' ms',
                    calcSeverity(summary.latencyP95, 8000, 15000),
                    'Reference: < 8,000 ms green, 8,000-15,000 ms watch, > 15,000 ms red',
                    'What it measures: the slowest 5% of interactions in the selected scope. Why it matters: high tail latency means the assistant is taking too long to respond for some requests, even if the average looks fine.'
                ),
                makeMetricCard(
                    'This chat is carrying too much context forward',
                    Math.round(summary.avgInputTokensPerEvent) + ' tokens',
                    calcSeverity(summary.avgInputTokensPerEvent, 800, 1200),
                    'Reference: < 800 tokens green, 800-1,200 watch, > 1,200 red',
                    'What it measures: how much conversation history and extra context are being carried into each call on average. Why it matters: large context usually means the chat is being kept alive too long instead of starting fresh for a new task.'
                ),
                makeMetricCard(
                    'The longest prompts are getting too large',
                    Math.round(summary.p90PromptChars) + ' chars',
                    calcSeverity(summary.p90PromptChars, 2500, 9000),
                    'Reference: < 2,500 chars green, 2,500-9,000 watch, > 9,000 red',
                    'What it measures: how large the longest prompts are in the top 10% of calls. Why it matters: very large prompts usually mean the same chat is carrying too much history into a request and the task may need a clean restart.'
                ),
                makeMetricCard(
                    'The AI response is touching too many files',
                    Math.round(summary.p90FilesRead) + ' files',
                    calcSeverity(summary.p90FilesRead, 3, 6),
                    'Reference: <= 3 files green, 4-6 watch, > 6 red',
                    'What it measures: how many files the AI response reaches into during the busiest 10% of work. Why it matters: a high number means the task is not small enough and the assistant is spreading across too many files at once.'
                ),
                makeMetricCard(
                    'Too many files are being added as context',
                    Math.round(summary.p90ContextFiles) + ' files',
                    calcSeverity(summary.p90ContextFiles, 2, 5),
                    'Reference: <= 2 files green, 3-5 watch, > 5 red',
                    'What it measures: how many supporting files were attached or included in the heaviest 10% of calls. Why it matters: too many context files usually means the request is too broad and should be broken into smaller steps.'
                ),
                makeMetricCard(
                    'This chat is mixing too many different tasks',
                    Math.round(summary.multiTaskSessionShare * 100) + '%',
                    calcSeverity(summary.multiTaskSessionShare, 0.2, 0.45),
                    'Reference: < 20% green, 20-45% watch, > 45% red',
                    'What it measures: how often one conversation mixes several different task types. Why it matters: mixed tasks make it harder to keep focus, so separate chats are usually cleaner for new work.'
                ),
                makeMetricCard(
                    'Tool steps are failing too often',
                    summary.toolSuccessTotal + summary.toolFailureTotal > 0
                        ? Math.round((summary.toolFailureTotal / (summary.toolSuccessTotal + summary.toolFailureTotal)) * 100) + '%'
                        : 'n/a',
                    summary.toolSuccessTotal + summary.toolFailureTotal > 0
                        ? calcSeverity(summary.toolFailureTotal / (summary.toolSuccessTotal + summary.toolFailureTotal), 0.03, 0.1)
                        : 'green',
                    'Reference: < 3% green, 3-10% watch, > 10% red',
                    'What it measures: how often tool calls fail in the selected scope. Why it matters: repeated failures usually mean the workflow or task shape is forcing the assistant into brittle steps.'
                ),
                makeMetricCard(
                    'The conversation is too broad for one task',
                    summary.top.taskType.length > 0 ? Math.round((summary.top.taskType[0].value / Math.max(1, summary.totalEvents)) * 100) + '% top task' : 'n/a',
                    summary.top.taskType.length > 0 ? calcSeverity(summary.top.taskType[0].value / Math.max(1, summary.totalEvents), 0.4, 0.6, true) : 'green',
                    'Reference: < 40% green, 40-60% watch, > 60% red',
                    'What it measures: whether one task type dominates the conversation. Why it matters: very high concentration can mean the chat is carrying too much unrelated work instead of staying focused on one small job.'
                ),
                makeMetricCard(
                    'Workload trend over time',
                    (() => {
                        const daily = summary.top.dailyEvents.filter(x => /^\\d{4}-\\d{2}-\\d{2}$/.test(x.label)).sort((a, b) => a.label.localeCompare(b.label));
                        if (daily.length < 4) return 'n/a';
                        const split = Math.floor(daily.length / 2);
                        const early = daily.slice(0, split);
                        const recent = daily.slice(split);
                        const earlyAvg = early.reduce((s, x) => s + x.value, 0) / Math.max(1, early.length);
                        const recentAvg = recent.reduce((s, x) => s + x.value, 0) / Math.max(1, recent.length);
                        const change = earlyAvg === 0 ? 0 : ((recentAvg - earlyAvg) / earlyAvg) * 100;
                        return (change >= 0 ? '+' : '') + Math.round(change) + '%';
                    })(),
                    (() => {
                        const daily = summary.top.dailyEvents.filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.label)).sort((a, b) => a.label.localeCompare(b.label));
                        if (daily.length < 4) return 'green';
                        const split = Math.floor(daily.length / 2);
                        const early = daily.slice(0, split);
                        const recent = daily.slice(split);
                        const earlyAvg = early.reduce((s, x) => s + x.value, 0) / Math.max(1, early.length);
                        const recentAvg = recent.reduce((s, x) => s + x.value, 0) / Math.max(1, recent.length);
                        if (earlyAvg === 0) return 'green';
                        const change = ((recentAvg - earlyAvg) / earlyAvg) * 100;
                        if (change >= 25) return 'green';
                        if (change <= -25) return 'yellow';
                        return 'yellow';
                    })(),
                    'Reference: +25% or more green, -25% to +25% watch, below -25% watch',
                    'What it measures: whether activity is rising or falling over time. Why it matters: a sharp drop can mean the workflow is slowing down, while a sharp rise can mean more work is being pushed through the same chat pattern.'
                ),
            ];

            const strip = document.getElementById('metricStateStrip');
            strip.innerHTML = '';
            cards.forEach(card => {
                const node = document.createElement('article');
                node.className = 'metric-state-card ' + (card.severity === 'red' ? 'metric-action' : card.severity === 'yellow' ? 'metric-watch' : 'metric-healthy');
                node.tabIndex = 0;
                node.setAttribute('role', 'button');
                node.setAttribute('aria-label', 'Open drilldown for ' + card.title);
                node.innerHTML =
                    '<span class="label">' + card.title + '</span>' +
                    '<span class="value">' + card.value + '</span>' +
                    '<div>' + metricBadge(card.severity) + '</div>' +
                    '<div class="metric-boundary">' + card.boundary + '</div>' +
                    '<div class="metric-note">' + card.note + '</div>';
                const metricKey = metricKeys[Math.min(metricKeys.length - 1, cards.indexOf(card))];
                const openMetric = () => {
                    state.activeMetric = metricKey;
                    renderDrilldown();
                };
                node.addEventListener('click', openMetric);
                node.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openMetric();
                    }
                });
                strip.appendChild(node);
            });
        };

        const render = () => {
            const summary = summarize(rawEvents);
            renderMetricCards(summary);
            document.getElementById('meta').textContent =
                'Generated: ' + new Date(data.generatedAt).toLocaleString() + ' | Log root: ' + data.logRoot + ' | Events: ' + fmt.format(summary.totalEvents);
            populateSelect(document.getElementById('drilldownSource'), distinctValues(rawEvents, 'source'));
            populateSelect(document.getElementById('drilldownClient'), distinctValues(rawEvents, 'assistantClient'));
            document.getElementById('drilldownStartDate').value = '';
            document.getElementById('drilldownEndDate').value = '';

            [
                'drilldownStartDate',
                'drilldownEndDate',
                'drilldownSource',
                'drilldownClient',
            ].forEach(id => {
                document.getElementById(id).addEventListener('change', renderDrilldown);
            });

            renderDrilldown();
        };

        render();
    </script>
</body>
</html>`;
}

function toBulletLines(counts: Record<string, number>): string[] {
    const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (entries.length === 0) {
        return ['- none'];
    }
    return entries.map(([k, v]) => `- ${k}: ${v}`);
}

function inc(map: Record<string, number>, key: string): void {
    map[key] = (map[key] ?? 0) + 1;
}

function asNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeLabel(value: string): string {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : 'unknown';
}

function avg(total: number, count: number): number {
    if (count === 0) {
        return 0;
    }
    return total / count;
}

function percentile(values: number[], p: number): number {
    if (values.length === 0) {
        return 0;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
}

function formatNumber(value: number): string {
    return Number.isFinite(value) ? value.toFixed(1) : '0.0';
}

main();
