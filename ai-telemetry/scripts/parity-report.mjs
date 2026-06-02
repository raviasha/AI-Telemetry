#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';

const defaultLogDir = path.join(os.homedir(), '.ai-telemetry', 'logs');
const logDir = process.argv[2] ? path.resolve(process.argv[2]) : defaultLogDir;
const maxFiles = Number.parseInt(process.env.PARITY_MAX_FILES ?? '14', 10);

const fields = [
  'source',
  'assistant_client',
  'assistant_name',
  'session_id',
  'interaction_key',
  'workspace_path',
  'interaction_number',
  'assistant_turns_count',
  'user_message_event_id',
  'user_message_timestamp',
  'first_turn_start_timestamp',
  'last_turn_end_timestamp',
  'prompt_char_length',
  'response_char_length',
  'context_files_count',
  'attachment_types',
  'tool_calls_count',
  'tool_names',
  'tool_breakdown',
  'tool_success_count',
  'tool_failure_count',
  'tool_latency_ms_total',
  'tool_latency_ms_avg',
  'tool_argument_char_length_total',
  'files_read',
  'task_type',
  'latency_ms',
  'idle_ms_since_prev_interaction',
  'has_reasoning',
  'reasoning_char_length',
  'reasoning_message_count'
];

function listLogFiles(dirPath) {
  let names = [];
  try {
    names = fs.readdirSync(dirPath);
  } catch {
    return [];
  }

  return names
    .filter(name => /^ai-telemetry-v4-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .slice(-maxFiles)
    .map(name => path.join(dirPath, name));
}

function hasValue(v) {
  if (v === undefined || v === null) {
    return false;
  }
  if (typeof v === 'string') {
    return v.trim().length > 0;
  }
  return true;
}

function initSourceStats() {
  const stats = {
    total: 0,
    fields: {}
  };

  for (const f of fields) {
    stats.fields[f] = {
      present: 0,
      missing: 0
    };
  }

  return stats;
}

function loadStats(files) {
  const bySource = new Map();

  for (const filePath of files) {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) {
        continue;
      }

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const source = typeof event.source === 'string' ? event.source : 'unknown';
      if (!bySource.has(source)) {
        bySource.set(source, initSourceStats());
      }

      const stats = bySource.get(source);
      stats.total += 1;

      for (const f of fields) {
        if (hasValue(event[f])) {
          stats.fields[f].present += 1;
        } else {
          stats.fields[f].missing += 1;
        }
      }
    }
  }

  return bySource;
}

function printSummary(bySource, files) {
  if (files.length === 0) {
    console.log(`No v4 telemetry files found in ${logDir}`);
    process.exit(0);
  }

  console.log(`Log directory: ${logDir}`);
  console.log(`Files scanned: ${files.length}`);
  console.log(`Field set size: ${fields.length}`);

  const copilot = bySource.get('copilot') ?? initSourceStats();
  const codex = bySource.get('codex') ?? initSourceStats();

  console.log('');
  console.log(`Events by source: copilot=${copilot.total}, codex=${codex.total}`);

  if (copilot.total === 0 || codex.total === 0) {
    console.log('');
    console.log('Need both sources present to compare parity rates.');
  }

  console.log('');
  console.log('Field completeness by source (% present):');
  console.log('field,copilot_pct,codex_pct,delta_pct');

  for (const f of fields) {
    const copPresent = copilot.fields[f].present;
    const codPresent = codex.fields[f].present;

    const copPct = copilot.total === 0 ? 0 : (copPresent / copilot.total) * 100;
    const codPct = codex.total === 0 ? 0 : (codPresent / codex.total) * 100;
    const delta = codPct - copPct;

    console.log(`${f},${copPct.toFixed(1)},${codPct.toFixed(1)},${delta.toFixed(1)}`);
  }
}

const files = listLogFiles(logDir);
const bySource = loadStats(files);
printSummary(bySource, files);
