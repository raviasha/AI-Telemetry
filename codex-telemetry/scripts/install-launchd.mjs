#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const label = 'com.ai-telemetry.codex';
const scriptFilePath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptFilePath), '..');
const nodePath = process.execPath;
const entryPath = path.join(projectRoot, 'out', 'index.js');

if (!fs.existsSync(entryPath)) {
  console.error(`Missing ${entryPath}. Run: npm run compile`);
  process.exit(1);
}

const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
const plistPath = path.join(launchAgentsDir, `${label}.plist`);
const daemonLogDir = path.join(os.homedir(), '.ai-telemetry', 'daemon');

const envVars = {
  AI_TELEMETRY_LOG_PATH: process.env.AI_TELEMETRY_LOG_PATH ?? '',
  AI_TELEMETRY_LOG_MODE: process.env.AI_TELEMETRY_LOG_MODE ?? '',
  CODEX_SESSION_ROOT: process.env.CODEX_SESSION_ROOT ?? '',
  CODEX_TELEMETRY_POLL_MS: process.env.CODEX_TELEMETRY_POLL_MS ?? ''
};

function xmlEscape(v) {
  return v
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function envXml() {
  const lines = [];
  const entries = Object.entries(envVars).filter(([, v]) => v.trim().length > 0);
  if (entries.length === 0) {
    return '';
  }

  lines.push('  <key>EnvironmentVariables</key>');
  lines.push('  <dict>');
  for (const [k, v] of entries) {
    lines.push(`    <key>${xmlEscape(k)}</key>`);
    lines.push(`    <string>${xmlEscape(v)}</string>`);
  }
  lines.push('  </dict>');
  return lines.join('\n');
}

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodePath)}</string>
    <string>${xmlEscape(entryPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(projectRoot)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
${envXml()}
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(daemonLogDir, 'stdout.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(daemonLogDir, 'stderr.log'))}</string>
</dict>
</plist>
`;

fs.mkdirSync(launchAgentsDir, { recursive: true });
fs.mkdirSync(daemonLogDir, { recursive: true });
fs.writeFileSync(plistPath, plist, 'utf8');

try {
  execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
} catch {
  // Ignore if not loaded yet.
}

execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plistPath], { stdio: 'inherit' });
execFileSync('launchctl', ['enable', `gui/${process.getuid()}/${label}`], { stdio: 'inherit' });
execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${label}`], { stdio: 'inherit' });

console.log(`Installed and started ${label}`);
console.log(`Plist: ${plistPath}`);
