#!/usr/bin/env node
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

const label = 'com.ai-telemetry.codex';
const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);

try {
  execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
} catch {
  // Ignore if already unloaded.
}

if (fs.existsSync(plistPath)) {
  fs.unlinkSync(plistPath);
}

console.log(`Uninstalled ${label}`);
console.log(`Removed plist: ${plistPath}`);
