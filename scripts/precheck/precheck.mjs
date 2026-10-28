#!/usr/bin/env node
/**
 * precheck.mjs — Comprehensive Pre-Push & Pre-Commit Evaluation Gate
 * =================================================================
 * Evaluates branch or staged changes against quality, security, and integrity rules.
 *
 * Supported flags:
 *   --mode=<branch|staged|full> (default: branch)
 *   --only=imports,tests        (run only specified checks)
 *   --skip=build,lint           (skip specified checks)
 *   --bail                      (stop on first failure)
 *   --strict                    (treat warnings as failures)
 *   --base=<ref>                (override merge-base target)
 *   --allow-main                (allow pushing from main/master)
 */

import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '../..');
const reportDir = path.join(rootDir, '.precheck');
const reportFile = path.join(reportDir, 'report.md');

// Load config
const configPath = path.join(__dirname, 'precheck.config.json');
let config = {
  strictMissingScripts: false,
  defaultBase: 'origin/main',
  maxFileSizeMB: 5,
  workspaces: [],
  smokeImportPrefixes: ['backend/lib'],
  smokeImportExclude: [],
  blockedBranches: ['main', 'master'],
};
if (fs.existsSync(configPath)) {
  try {
    config = { ...config, ...JSON.parse(fs.readFileSync(configPath, 'utf8')) };
  } catch (err) {
    console.warn('⚠️ Warning: Failed to parse precheck.config.json, using defaults.');
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
function getArgValue(name, defaultValue = null) {
  const match = args.find((a) => a.startsWith(`--${name}=`));
  if (match) return match.split('=')[1];
  return args.includes(`--${name}`) ? true : defaultValue;
}

const mode = getArgValue('mode', 'branch'); // 'branch' | 'staged' | 'full'
const onlyArg = getArgValue('only', null);
const skipArg = getArgValue('skip', null);
const bail = Boolean(getArgValue('bail', false));
const strict = Boolean(getArgValue('strict', false));
const allowMain = Boolean(getArgValue('allow-main', false));
const customBase = getArgValue('base', null);

const onlyChecks = onlyArg ? onlyArg.split(',').map((s) => s.trim().toLowerCase()) : null;
const skipChecks = skipArg ? skipArg.split(',').map((s) => s.trim().toLowerCase()) : [];

function shouldRun(checkName) {
  const name = checkName.toLowerCase();
  if (skipChecks.includes(name)) return false;
  if (onlyChecks && !onlyChecks.includes(name)) return false;
  return true;
}

// Git Helpers
function runGit(cmd, ignoreError = false) {
  try {
    return execSync(`git ${cmd}`, { cwd: rootDir, stdio: 'pipe', encoding: 'utf8' }).trim();
  } catch (err) {
    if (ignoreError) return '';
    throw err;
  }
}

function resolveBaseRef() {
  if (customBase) return customBase;
  const candidates = [config.defaultBase, 'main', 'master', 'HEAD~1'];
  for (const ref of candidates) {
    try {
      runGit(`rev-parse --verify ${ref}`);
      return ref;
    } catch {
      // try next candidate
    }
  }
  return 'HEAD~1';
}

let mergeBase = null;
let currentBranch = '';
try {
  currentBranch = runGit('rev-parse --abbrev-ref HEAD', true) || 'unknown';
  if (mode === 'branch') {
    const baseCandidate = resolveBaseRef();
    try {
      mergeBase = runGit(`merge-base ${baseCandidate} HEAD`);
    } catch {
      mergeBase = baseCandidate;
    }
  }
} catch (err) {
  console.warn('⚠️ Warning: Unable to resolve merge-base:', err.message);
}

// Resolve Files & Diff
function getTargetFiles() {
  if (mode === 'staged') {
    const out = runGit('diff --name-only --cached', true);
    return out ? out.split('\n').filter(Boolean) : [];
  }
  if (mode === 'full') {
    const out = runGit('ls-files', true);
    return out ? out.split('\n').filter(Boolean) : [];
  }
  // branch mode
  if (mergeBase) {
    const out = runGit(`diff --name-only ${mergeBase}...HEAD`, true);
    return out ? out.split('\n').filter(Boolean) : [];
  }
  const out = runGit('diff --name-only HEAD~1', true);
  return out ? out.split('\n').filter(Boolean) : [];
}

function getAddedLinesByFile() {
  let diffText = '';
  if (mode === 'staged') {
    diffText = runGit('diff -U0 --cached', true);
  } else if (mode === 'full') {
    return new Map();
  } else if (mergeBase) {
    diffText = runGit(`diff -U0 ${mergeBase}...HEAD`, true);
  } else {
    diffText = runGit('diff -U0 HEAD~1', true);
  }

  const map = new Map();
  if (!diffText) return map;

  let currentFile = null;
  let currentLineNumber = 0;

  for (const line of diffText.split('\n')) {
    if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6).trim();
      if (!map.has(currentFile)) map.set(currentFile, []);
    } else if (line.startsWith('@@ ')) {
      // Parse @@ -a,b +c,d @@
      const match = line.match(/\+([0-9]+)/);
      if (match) currentLineNumber = parseInt(match[1], 10);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (currentFile) {
        map.get(currentFile).push({
          lineNumber: currentLineNumber,
          content: line.slice(1),
        });
      }
      currentLineNumber++;
    }
  }
  return map;
}

const targetFiles = getTargetFiles();
const addedLinesMap = getAddedLinesByFile();

// Results Tracker
const checkResults = [];
let hasFailures = false;
let hasWarnings = false;

function addResult(name, status, summary, details = []) {
  if (status === 'FAIL') hasFailures = true;
  if (status === 'WARN') hasWarnings = true;
  checkResults.push({ name, status, summary, details });
  const icon = status === 'PASS' ? '✅' : status === 'WARN' ? '⚠️' : status === 'SKIP' ? '⏭️' : '❌';
  console.log(`${icon} [${name.toUpperCase()}] ${summary}`);
  for (const d of details) {
    console.log(`   └─ ${d}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 1: git-state
// ─────────────────────────────────────────────────────────────────────────────
function checkGitState() {
  if (!shouldRun('git-state')) return addResult('git-state', 'SKIP', 'Skipped by filter');
  const issues = [];

  // Check branch
  if (mode === 'branch' && !allowMain && !process.env.CI) {
    if (config.blockedBranches.includes(currentBranch)) {
      issues.push(`Direct push from protected branch '${currentBranch}' is blocked. Create a feature branch.`);
    }
  }

  // Check uncommitted changes in branch mode (ignoring precheck's own generated report)
  if (mode === 'branch' && !process.env.CI) {
    const status = runGit('status --porcelain', true);
    if (status) {
      const dirtyFiles = status
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !l.includes('.precheck') && !l.includes('report.md'));
      if (dirtyFiles.length > 0) {
        issues.push(`Working tree has uncommitted changes (${dirtyFiles.slice(0, 3).join(', ')}${dirtyFiles.length > 3 ? '...' : ''}). Stash or commit before pushing to ensure clean evaluation.`);
      }
    }
  }

  // Check for fixup! or squash! commits in branch
  if (mode === 'branch' && mergeBase) {
    const log = runGit(`log ${mergeBase}..HEAD --oneline`, true);
    if (log) {
      for (const entry of log.split('\n')) {
        if (/^[a-f0-9]+ (fixup!|squash!|wip:)/i.test(entry)) {
          issues.push(`Temporary commit found: "${entry}". Rebase or clean up before push.`);
        }
      }
    }
  }

  if (issues.length > 0) {
    addResult('git-state', 'FAIL', 'Git repository state violations found', issues);
  } else {
    addResult('git-state', 'PASS', `Branch '${currentBranch}' state clean`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 2: paths-and-size
// ─────────────────────────────────────────────────────────────────────────────
function checkPathsAndSize() {
  if (!shouldRun('paths-and-size')) return addResult('paths-and-size', 'SKIP', 'Skipped by filter');
  const issues = [];
  const maxBytes = (config.maxFileSizeMB || 5) * 1024 * 1024;

  const forbiddenNamePatterns = [
    /^\.env(\..+)?$/i,
    /learnings\.json$/i,
    /\.(pem|key|pfx|pkcs12)$/i,
  ];

  for (const file of targetFiles) {
    const basename = path.basename(file);
    const normalized = file.replace(/\\/g, '/');

    // Forbidden files
    for (const pat of forbiddenNamePatterns) {
      if (pat.test(basename)) {
        if (basename.endsWith('.example') || basename.endsWith('.sample') || basename.endsWith('.template')) {
          continue;
        }
        issues.push(`Forbidden sensitive file tracked: ${file}`);
      }
    }

    // Screenshots forbidden
    if (normalized.includes('screenshots/') && /\.(png|jpe?g|webp|gif)$/i.test(basename)) {
      issues.push(`Committed screenshot file: ${file} (Violates Zero Local Screenshots Policy)`);
    }

    // File size check
    const fullPath = path.join(rootDir, file);
    if (fs.existsSync(fullPath)) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size > maxBytes) {
          const mb = (stat.size / (1024 * 1024)).toFixed(2);
          issues.push(`File exceeds size limit (${mb} MB > ${config.maxFileSizeMB} MB): ${file}`);
        }
      } catch {}
    }
  }

  if (issues.length > 0) {
    addResult('paths-and-size', 'FAIL', `${issues.length} file path or size violations detected`, issues);
  } else {
    addResult('paths-and-size', 'PASS', 'All paths and file sizes within limits');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 3: secrets
// ─────────────────────────────────────────────────────────────────────────────
function checkSecrets() {
  if (!shouldRun('secrets')) return addResult('secrets', 'SKIP', 'Skipped by filter');
  const issues = [];

  const secretPatterns = [
    { name: 'Supabase JWT / Service Role', regex: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
    { name: 'Anthropic API Key', regex: /sk-ant-[a-zA-Z0-9_\-]{20,}/g },
    { name: 'OpenRouter API Key', regex: /sk-or-v1-[a-zA-Z0-9]{32,}|sk-or-[a-zA-Z0-9]{20,}/g },
    { name: 'OpenAI API Key', regex: /sk-proj-[a-zA-Z0-9_\-]{20,}|sk-[a-zA-Z0-9]{32,}/g },
    { name: 'Groq API Key', regex: /gsk_[a-zA-Z0-9]{20,}/g },
    { name: 'Telegram Bot Token', regex: /[0-9]{8,10}:[a-zA-Z0-9_-]{35}/g },
    { name: 'Private Key', regex: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  ];

  for (const [file, lines] of addedLinesMap.entries()) {
    for (const { lineNumber, content } of lines) {
      if (content.includes('precheck:allow')) continue;
      for (const { name, regex } of secretPatterns) {
        regex.lastIndex = 0;
        if (regex.test(content)) {
          issues.push(`${file}:${lineNumber} — Detected ${name} (value redacted)`);
        }
      }
    }
  }

  if (issues.length > 0) {
    addResult('secrets', 'FAIL', `${issues.length} secret(s) detected in added lines`, issues);
  } else {
    addResult('secrets', 'PASS', 'No unredacted secrets found in changed code');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 4: code-patterns
// ─────────────────────────────────────────────────────────────────────────────
function checkCodePatterns() {
  if (!shouldRun('code-patterns')) return addResult('code-patterns', 'SKIP', 'Skipped by filter');
  const errors = [];
  const warnings = [];

  for (const [file, lines] of addedLinesMap.entries()) {
    const isFrontend = file.startsWith('frontend/');
    const isTest = file.includes('test') || file.includes('spec');

    for (const { lineNumber, content } of lines) {
      if (content.includes('precheck:allow')) continue;

      // 1. Local disk screenshot
      if (/(page\.screenshot|screenshot)\s*\(\s*\{[^}]*path\s*:/i.test(content)) {
        errors.push(`${file}:${lineNumber} — Local disk screenshot call detected. Screenshots must be in-memory buffers streamed to cloud.`);
      }

      // 2. Service role in frontend
      if (isFrontend && /(SUPABASE_SERVICE_ROLE_KEY|service_role)/.test(content)) {
        errors.push(`${file}:${lineNumber} — Frontend code must never access or reference SUPABASE_SERVICE_ROLE_KEY.`);
      }

      // 3. Focused tests (.only)
      if (isTest && /\.(only)\s*\(/.test(content)) {
        errors.push(`${file}:${lineNumber} — Focused test statement (.only) left in test file.`);
      }

      // 4. Debugger statement
      if (/\bdebugger\b/.test(content)) {
        errors.push(`${file}:${lineNumber} — Debugger statement left in code.`);
      }

      // 5. Conflict markers
      if (/^<{7} |^={7}$|^>{7} /.test(content)) {
        errors.push(`${file}:${lineNumber} — Unresolved Git merge conflict marker detected.`);
      }

      // 6. Hardcoded user home / machine paths
      if (/[A-Za-z]:\\[Uu]sers\\[^\\]+|(\/(home|Users)\/[a-zA-Z0-9_.-]+)/.test(content)) {
        errors.push(`${file}:${lineNumber} — Hardcoded local machine path found.`);
      }

      // Warnings: empty catch
      if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(content)) {
        warnings.push(`${file}:${lineNumber} — Empty catch block swallowing error silently.`);
      }

      // Warnings: while (true) without sleep or break
      if (/while\s*\(\s*true\s*\)/.test(content) && !/(break|return|sleep|await)/.test(content)) {
        warnings.push(`${file}:${lineNumber} — Potential unbounded loop without break or await.`);
      }
    }
  }

  const allDetails = [...errors, ...warnings.map((w) => `[WARN] ${w}`)];
  if (errors.length > 0) {
    addResult('code-patterns', 'FAIL', `${errors.length} forbidden code pattern(s) found`, allDetails);
  } else if (warnings.length > 0) {
    addResult('code-patterns', strict ? 'FAIL' : 'WARN', `${warnings.length} code pattern warning(s)`, allDetails);
  } else {
    addResult('code-patterns', 'PASS', 'Clean code patterns; no anti-patterns found');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 5: syntax
// ─────────────────────────────────────────────────────────────────────────────
function checkSyntax() {
  if (!shouldRun('syntax')) return addResult('syntax', 'SKIP', 'Skipped by filter');
  const issues = [];

  for (const file of targetFiles) {
    const fullPath = path.join(rootDir, file);
    if (!fs.existsSync(fullPath)) continue;

    const ext = path.extname(file).toLowerCase();

    // JavaScript Syntax via node --check
    if (ext === '.mjs' || ext === '.cjs' || (ext === '.js' && (file.startsWith('backend/') || file === 'index.js'))) {
      try {
        execSync(`node --check "${file}"`, { cwd: rootDir, stdio: 'pipe' });
      } catch (err) {
        issues.push(`Syntax error in ${file}: ${err.stderr?.toString() || err.message}`);
      }
    }

    // JSON Validation
    if (ext === '.json') {
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        JSON.parse(raw);
      } catch (err) {
        issues.push(`Invalid JSON syntax in ${file}: ${err.message}`);
      }
    }

    // YAML Validation (basic indentation/tab check)
    if (ext === '.yml' || ext === '.yaml') {
      try {
        const raw = fs.readFileSync(fullPath, 'utf8');
        if (/^\t+/m.test(raw)) {
          issues.push(`Invalid YAML in ${file}: contains tab characters.`);
        }
      } catch (err) {
        issues.push(`Error reading YAML file ${file}: ${err.message}`);
      }
    }
  }

  if (issues.length > 0) {
    addResult('syntax', 'FAIL', `${issues.length} syntax validation error(s)`, issues);
  } else {
    addResult('syntax', 'PASS', 'All changed JS, JSON, and YAML files pass syntax checks');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 6: imports
// ─────────────────────────────────────────────────────────────────────────────
function checkImports() {
  if (!shouldRun('imports')) return addResult('imports', 'SKIP', 'Skipped by filter');
  const issues = [];

  // Load root package.json dependencies
  let rootDeps = new Set();
  try {
    const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    rootDeps = new Set([
      ...Object.keys(rootPkg.dependencies || {}),
      ...Object.keys(rootPkg.devDependencies || {}),
    ]);
  } catch {}

  const importRegex = /(?:^\s*import\s+(?:[\w*\s{},]*\s+from\s+)?['"]([^'"]+)['"]|^\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*export\s+[\w*\s{},]*\s+from\s+['"]([^'"]+)['"])/gm;

  for (const file of targetFiles) {
    const ext = path.extname(file).toLowerCase();
    if (!['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx'].includes(ext)) continue;

    const fullPath = path.join(rootDir, file);
    if (!fs.existsSync(fullPath)) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    let match;
    importRegex.lastIndex = 0;

    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1] || match[2] || match[3];
      if (!importPath || importPath.includes('${') || importPath.startsWith('$')) continue;

      // Node built-ins & custom schemes
      const nodeBuiltins = [
        'fs', 'path', 'http', 'https', 'child_process', 'crypto', 'os', 'util',
        'url', 'events', 'assert', 'readline', 'process', 'stream', 'buffer',
        'zlib', 'net', 'tls', 'dns', 'constants', 'timers', 'string_decoder',
        'perf_hooks', 'worker_threads', 'v8', 'vm', 'fs/promises'
      ];
      const rootMod = importPath.split('/')[0];
      if (importPath.startsWith('node:') || nodeBuiltins.includes(importPath) || nodeBuiltins.includes(rootMod) || importPath.startsWith('file:')) {
        continue;
      }

      // Relative imports
      if (importPath.startsWith('./') || importPath.startsWith('../')) {
        const dir = path.dirname(fullPath);
        const resolvedPath = path.resolve(dir, importPath);

        // Extension resolution
        const hasExt = path.extname(importPath) !== '';
        if (!hasExt && !fs.existsSync(resolvedPath)) {
          const exts = ['.jsx', '.js', '.tsx', '.ts', '.mjs', '/index.jsx', '/index.js', '/index.tsx', '/index.ts'];
          const matched = exts.find((e) => fs.existsSync(resolvedPath + e));
          if (matched) {
            // Frontend bundlers (Vite/React) support extensionless imports
            if (file.startsWith('frontend/')) {
              continue;
            } else if (!file.endsWith('.mjs')) {
              continue;
            } else {
              issues.push(`${file} — Import '${importPath}' is missing explicit file extension (.mjs/.js).`);
              continue;
            }
          }
        }

        if (!fs.existsSync(resolvedPath)) {
          // If in try/catch or dynamic optional, verify if actually missing
          issues.push(`${file} — Unresolved relative import: '${importPath}' (file does not exist).`);
          continue;
        }

        // Exact letter-case check (Windows is case-insensitive, Linux fails)
        try {
          const parentDir = path.dirname(resolvedPath);
          const targetBase = path.basename(resolvedPath);
          const entries = fs.readdirSync(parentDir);
          const exactMatch = entries.find((e) => e.toLowerCase() === targetBase.toLowerCase() && e === targetBase);
          if (!exactMatch) {
            issues.push(`${file} — Case mismatch in import '${importPath}'. Real filename casing on disk differs.`);
          }
        } catch {}
      } else {
        // Package import check
        const pkgName = importPath.startsWith('@')
          ? importPath.split('/').slice(0, 2).join('/')
          : importPath.split('/')[0];

        // Check if declared in root or workspace package.json
        let declared = rootDeps.has(pkgName);
        if (!declared && file.startsWith('backend/')) {
          try {
            const bPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'backend/package.json'), 'utf8'));
            declared = bPkg.dependencies?.[pkgName] || bPkg.devDependencies?.[pkgName];
          } catch {}
        }
        if (!declared && file.startsWith('frontend/')) {
          try {
            const fPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'frontend/package.json'), 'utf8'));
            declared = fPkg.dependencies?.[pkgName] || fPkg.devDependencies?.[pkgName];
          } catch {}
        }

        if (!declared) {
          issues.push(`${file} — Package '${pkgName}' imported but not listed in package.json dependencies.`);
        }
      }
    }
  }

  if (issues.length > 0) {
    addResult('imports', 'FAIL', `${issues.length} unresolved or invalid import(s)`, issues);
  } else {
    addResult('imports', 'PASS', 'All imports valid, extensions present, and case-sensitive');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 7: migrations
// ─────────────────────────────────────────────────────────────────────────────
function checkMigrations() {
  if (!shouldRun('migrations')) return addResult('migrations', 'SKIP', 'Skipped by filter');
  const issues = [];

  const migrationDirs = ['migrations', 'backend/supabase-migrations'];

  for (const mDir of migrationDirs) {
    const fullDir = path.join(rootDir, mDir);
    if (!fs.existsSync(fullDir)) continue;

    const numbersSeen = new Map();
    const files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.sql'));

    for (const f of files) {
      const match = f.match(/^(\d{3})_/);
      if (match) {
        const num = match[1];
        const relPath = path.join(mDir, f).replace(/\\/g, '/');
        if (numbersSeen.has(num)) {
          const prev = numbersSeen.get(num);
          // Flag if at least one of the duplicate files is in the target/changed files
          const isTarget = targetFiles.some((tf) => tf.replace(/\\/g, '/') === relPath || tf.replace(/\\/g, '/') === prev);
          if (isTarget) {
            issues.push(`Duplicate migration number prefix '${num}' in ${mDir}: ${path.basename(prev)} and ${f}`);
          }
        } else {
          numbersSeen.set(num, relPath);
        }
      }
    }
  }

  // Check destructive queries in newly added lines
  const destructiveRegex = /\b(DROP\s+TABLE|TRUNCATE\s+TABLE|ALTER\s+TABLE\s+[\w.]+\s+RENAME|DELETE\s+FROM\s+[\w.]+\s*;)/i;

  for (const [file, lines] of addedLinesMap.entries()) {
    if (!file.endsWith('.sql')) continue;
    for (const { lineNumber, content } of lines) {
      if (content.includes('precheck:allow-destructive')) continue;
      if (destructiveRegex.test(content)) {
        issues.push(`${file}:${lineNumber} — Destructive migration statement detected (${content.trim()}). Override with '-- precheck:allow-destructive' if intentional.`);
      }
    }
  }

  if (issues.length > 0) {
    const hasDestructive = issues.some((i) => i.includes('Destructive migration'));
    const status = (hasDestructive || strict) ? 'FAIL' : 'WARN';
    addResult('migrations', status, `${issues.length} migration issue(s) detected`, issues);
  } else {
    addResult('migrations', 'PASS', 'Migrations clean with no duplicate prefixes or unsafe statements');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 8: dependencies
// ─────────────────────────────────────────────────────────────────────────────
function checkDependencies() {
  if (!shouldRun('dependencies')) return addResult('dependencies', 'SKIP', 'Skipped by filter');
  const issues = [];

  const pkgChanged = targetFiles.some((f) => f.endsWith('package.json'));
  const lockChanged = targetFiles.some((f) => f.endsWith('package-lock.json'));

  if (pkgChanged && !lockChanged) {
    issues.push('package.json was modified without updating package-lock.json. Run `npm install` to refresh lockfile.');
  }

  if (issues.length > 0) {
    addResult('dependencies', 'FAIL', 'Lockfile out of sync with package.json', issues);
  } else {
    addResult('dependencies', 'PASS', 'Dependencies and lockfile in sync');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 9: smoke-import
// ─────────────────────────────────────────────────────────────────────────────
function checkSmokeImport() {
  if (!shouldRun('smoke-import')) return addResult('smoke-import', 'SKIP', 'Skipped by filter');
  const issues = [];

  const prefixes = config.smokeImportPrefixes || ['backend/lib'];
  const excludes = new Set(config.smokeImportExclude || []);

  const candidates = targetFiles.filter((f) => {
    if (!f.endsWith('.mjs')) return false;
    const normalized = f.replace(/\\/g, '/');
    if (normalized.includes('.test.') || normalized.includes('.spec.')) return false;
    if (excludes.has(normalized)) return false;
    return prefixes.some((p) => normalized.startsWith(p));
  });

  const dummyEnv = {
    ...process.env,
    NODE_ENV: 'test',
    HEADLESS: 'true',
    SCANNER_RUN: 'false',
    SUBMIT_RUN: 'false',
    PORT: '0',
    SUPABASE_URL: 'https://dummy.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'dummy-key',
    CLAUDE_API_KEY: 'dummy-key',
    ANTHROPIC_API_KEY: 'dummy-key',
    OPENROUTER_API_KEY: 'dummy-key',
  };

  for (const file of candidates) {
    const fullPath = path.join(rootDir, file);
    if (!fs.existsSync(fullPath)) continue;

    const res = spawnSync('node', ['-e', `import('./' + process.argv[1]).then(() => process.exit(0)).catch((e) => { console.error(e.stack || e); process.exit(1); })`, file], {
      cwd: rootDir,
      env: dummyEnv,
      timeout: 6000,
      encoding: 'utf8',
    });

    if (res.status !== 0) {
      const errOut = (res.stderr || res.stdout || 'Process terminated with non-zero exit code').trim();
      issues.push(`Smoke import failed for ${file}:\n      ${errOut.split('\n')[0]}`);
    }
  }

  if (issues.length > 0) {
    addResult('smoke-import', 'FAIL', `${issues.length} module(s) failed load-time smoke import`, issues);
  } else {
    addResult('smoke-import', 'PASS', `${candidates.length} module(s) evaluated cleanly on import`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 10: lint
// ─────────────────────────────────────────────────────────────────────────────
function checkLint() {
  if (!shouldRun('lint')) return addResult('lint', 'SKIP', 'Skipped by filter');
  try {
    execSync('npm run lint', { cwd: rootDir, stdio: 'pipe' });
    addResult('lint', 'PASS', 'Project lint checks passed');
  } catch (err) {
    const output = (err.stdout?.toString() || err.stderr?.toString() || err.message).trim();
    const firstLines = output.split('\n').slice(0, 10).join('\n   │ ');
    addResult('lint', 'FAIL', 'Lint errors detected', [`Errors output:\n   │ ${firstLines}`]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 11: tests
// ─────────────────────────────────────────────────────────────────────────────
function checkTests() {
  if (!shouldRun('tests')) return addResult('tests', 'SKIP', 'Skipped by filter');
  try {
    execSync('npm test', { cwd: rootDir, stdio: 'pipe' });
    addResult('tests', 'PASS', 'Unit test suite passed cleanly');
  } catch (err) {
    const output = (err.stdout?.toString() || err.stderr?.toString() || err.message).trim();
    const firstLines = output.split('\n').slice(0, 8).join('\n   │ ');
    addResult('tests', 'FAIL', 'Unit tests failed', [`Test output:\n   │ ${firstLines}`]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK 12: build
// ─────────────────────────────────────────────────────────────────────────────
function checkBuild() {
  if (!shouldRun('build')) return addResult('build', 'SKIP', 'Skipped by filter');
  try {
    execSync('npm --prefix frontend run build', { cwd: rootDir, stdio: 'pipe' });
    addResult('build', 'PASS', 'Frontend Vite build compiled successfully');
  } catch (err) {
    const output = (err.stderr?.toString() || err.stdout?.toString() || err.message).trim();
    const firstLines = output.split('\n').slice(0, 8).join('\n   │ ');
    addResult('build', 'FAIL', 'Frontend build failed', [`Build output:\n   │ ${firstLines}`]);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Execution Orchestrator
// ─────────────────────────────────────────────────────────────────────────────
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`🛡️  PRE-PUSH EVALUATION GATE (Mode: ${mode.toUpperCase()})`);
console.log(`   Branch: ${currentBranch} | Base: ${mergeBase || 'N/A'}`);
console.log(`   Evaluating ${targetFiles.length} file(s)`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const startTime = Date.now();
const allCheckFns = [
  checkGitState,
  checkPathsAndSize,
  checkSecrets,
  checkCodePatterns,
  checkSyntax,
  checkImports,
  checkMigrations,
  checkDependencies,
  checkSmokeImport,
  checkLint,
  checkTests,
  checkBuild,
];

for (const fn of allCheckFns) {
  fn();
  if (bail && hasFailures) {
    console.log('\n🛑 Bail requested: halting further checks on first failure.');
    break;
  }
}

const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(2);

// Generate Markdown Report
if (!fs.existsSync(reportDir)) {
  fs.mkdirSync(reportDir, { recursive: true });
}

let reportMd = `# Pre-Push Evaluation Gate Report\n\n`;
reportMd += `- **Date**: ${new Date().toISOString()}\n`;
reportMd += `- **Branch**: \`${currentBranch}\`\n`;
reportMd += `- **Evaluation Mode**: \`${mode}\`\n`;
reportMd += `- **Merge Base**: \`${mergeBase || 'N/A'}\`\n`;
reportMd += `- **Files Checked**: \`${targetFiles.length}\`\n`;
reportMd += `- **Duration**: \`${elapsedSec}s\`\n`;
reportMd += `- **Overall Status**: **${hasFailures ? 'FAILED ❌' : hasWarnings ? 'PASSED WITH WARNINGS ⚠️' : 'PASSED ✅'}**\n\n`;

reportMd += `## Evaluation Summary\n\n`;
reportMd += `| Check | Status | Summary |\n`;
reportMd += `|---|---|---|\n`;

for (const r of checkResults) {
  const icon = r.status === 'PASS' ? '✅ PASS' : r.status === 'WARN' ? '⚠️ WARN' : r.status === 'SKIP' ? '⏭️ SKIP' : '❌ FAIL';
  reportMd += `| **${r.name}** | ${icon} | ${r.summary} |\n`;
}

const failureOrWarns = checkResults.filter((r) => r.details && r.details.length > 0);
if (failureOrWarns.length > 0) {
  reportMd += `\n## Detailed Findings\n\n`;
  for (const r of failureOrWarns) {
    reportMd += `### ${r.name.toUpperCase()} (${r.status})\n`;
    for (const d of r.details) {
      reportMd += `- ${d}\n`;
    }
    reportMd += `\n`;
  }
}

reportMd += `---\n*Generated by \`scripts/precheck/precheck.mjs\`*\n`;
fs.writeFileSync(reportFile, reportMd, 'utf8');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`📋 Gate Report written to: .precheck/report.md (${elapsedSec}s)`);
if (hasFailures) {
  console.log('❌ PRECHECK FAILED — One or more gate checks failed.');
  process.exit(1);
} else if (hasWarnings && strict) {
  console.log('❌ PRECHECK FAILED — Strict mode active; warnings treated as errors.');
  process.exit(1);
} else {
  console.log('✅ PRECHECK PASSED — All verification gates satisfied!');
  process.exit(0);
}
