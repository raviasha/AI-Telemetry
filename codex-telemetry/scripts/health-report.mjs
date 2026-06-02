#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';

const TARGET_SCHEMA = '4.0';
const defaultLogBase = process.env.AI_TELEMETRY_LOG_PATH?.trim() || path.join(os.homedir(), '.ai-telemetry', 'logs');
const inputBase = process.argv[2] ? path.resolve(process.argv[2]) : defaultLogBase;
const maxFiles = Number.parseInt(process.env.HEALTH_MAX_FILES ?? '30', 10);

function listTelemetryFiles(rootDir) {
  const files = [];

  const walk = (dir) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && /^ai-telemetry-v4-\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name)) {
        files.push(full);
      }
    }
  };

  walk(rootDir);
  files.sort();
  return files.slice(-maxFiles);
}

function initSourceStats() {
  return {
    events: 0,
    schemaValid: 0,
    schemaInvalid: 0,
    lastTimestamp: null,
    recent24h: 0
  };
}

function analyze(files) {
  const now = Date.now();
  const last24hMs = 24 * 60 * 60 * 1000;

  const out = {
    filesScanned: files.length,
    malformedLines: 0,
    totalLines: 0,
    bySource: new Map(),
    bySourceAndClient: new Map(),
    schemaVersionCounts: {}
  };

  for (const filePath of files) {
    let raw = '';
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    const lines = raw.split('\n');
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }

      out.totalLines += 1;

      let event;
      try {
        event = JSON.parse(line);
      } catch {
        out.malformedLines += 1;
        continue;
      }

      const source = typeof event.source === 'string' ? event.source : 'unknown';
      const assistantClient = typeof event.assistant_client === 'string' ? event.assistant_client : 'unknown';
      if (!out.bySource.has(source)) {
        out.bySource.set(source, initSourceStats());
      }
      const stats = out.bySource.get(source);
      stats.events += 1;

      const sourceClientKey = `${source}:${assistantClient}`;
      out.bySourceAndClient.set(sourceClientKey, (out.bySourceAndClient.get(sourceClientKey) ?? 0) + 1);

      const sv = typeof event.schema_version === 'string' ? event.schema_version : 'missing';
      out.schemaVersionCounts[sv] = (out.schemaVersionCounts[sv] ?? 0) + 1;

      if (sv === TARGET_SCHEMA) {
        stats.schemaValid += 1;
      } else {
        stats.schemaInvalid += 1;
      }

      const ts = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
      if (Number.isFinite(ts)) {
        const iso = new Date(ts).toISOString();
        if (!stats.lastTimestamp || iso > stats.lastTimestamp) {
          stats.lastTimestamp = iso;
        }
        if ((now - ts) <= last24hMs) {
          stats.recent24h += 1;
        }
      }
    }
  }

  return out;
}

function printReport(rootDir, result) {
  console.log(`Log root: ${rootDir}`);
  console.log(`Files scanned: ${result.filesScanned}`);
  console.log(`Total non-empty lines: ${result.totalLines}`);
  console.log(`Malformed lines: ${result.malformedLines}`);

  console.log('');
  console.log('Schema versions seen:');
  const versions = Object.keys(result.schemaVersionCounts).sort();
  if (versions.length === 0) {
    console.log('  none');
  } else {
    for (const v of versions) {
      console.log(`  ${v}: ${result.schemaVersionCounts[v]}`);
    }
  }

  console.log('');
  console.log('Per-source health:');
  if (result.bySource.size === 0) {
    console.log('  no events found');
    return;
  }

  const names = Array.from(result.bySource.keys()).sort((a, b) => a.localeCompare(b));
  for (const source of names) {
    const s = result.bySource.get(source);
    const pct = s.events === 0 ? 0 : (s.schemaValid / s.events) * 100;
    console.log(`  ${source}: events=${s.events}, schema_valid=${s.schemaValid}, schema_invalid=${s.schemaInvalid}, valid_pct=${pct.toFixed(1)}, recent_24h=${s.recent24h}, last_timestamp=${s.lastTimestamp ?? 'n/a'}`);
  }

  console.log('');
  console.log('Source/client matrix:');
  if (result.bySourceAndClient.size === 0) {
    console.log('  no events found');
    return;
  }

  const keys = Array.from(result.bySourceAndClient.keys()).sort((a, b) => a.localeCompare(b));
  for (const key of keys) {
    console.log(`  ${key} => ${result.bySourceAndClient.get(key)}`);
  }
}

const files = listTelemetryFiles(inputBase);
const result = analyze(files);
printReport(inputBase, result);
