#!/usr/bin/env node
/**
 * install-hooks.mjs — Configures Git to use local repository hooks in .githooks/
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const hooksDir = path.join(rootDir, '.githooks');

console.log('⚡ Installing Git hooks for Pre-Push Evaluation Gate...');

try {
  // 1. Verify inside git repo
  execSync('git rev-parse --is-inside-work-tree', { cwd: rootDir, stdio: 'pipe' });

  // 2. Ensure .githooks directory exists
  if (!fs.existsSync(hooksDir)) {
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // 3. Configure core.hooksPath
  execSync('git config core.hooksPath .githooks', { cwd: rootDir, stdio: 'inherit' });

  // 4. On POSIX systems, ensure hooks have execute permissions
  if (process.platform !== 'win32') {
    const prePush = path.join(hooksDir, 'pre-push');
    const preCommit = path.join(hooksDir, 'pre-commit');
    if (fs.existsSync(prePush)) fs.chmodSync(prePush, 0o755);
    if (fs.existsSync(preCommit)) fs.chmodSync(preCommit, 0o755);
  }

  console.log('✅ Git hooks successfully installed!');
  console.log('   `core.hooksPath` set to `.githooks`');
  console.log('   Hooks active: `pre-push` (branch evaluation), `pre-commit` (staged fast-check)');
} catch (err) {
  console.error('❌ Failed to install Git hooks:', err.message);
  process.exit(1);
}
