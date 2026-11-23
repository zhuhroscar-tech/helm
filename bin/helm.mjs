#!/usr/bin/env node
// Helm CLI: start | config [init] [--json] | doctor | version | help
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeConfig, SCHEMA } from '../lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [cmd = 'help', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((a) => a.startsWith('--')));
const args = rest.filter((a) => !a.startsWith('--'));

const HELP = `helm <command>

  start           load config, then start the server
  config          show effective settings and where each came from (--json for JSON)
  config init     create helm.config.json from defaults (never overwrites)
  doctor          check prerequisites (Node, claude, dotnet, LEAN, Python, config)
  version         print version
  help            this text

Config: defaults < helm.config.json (or $HELM_CONFIG) < environment variables.
See docs/CONFIGURATION.md.`;

const load = () => loadConfig({ root: ROOT });
function printProblems(cfg) {
  for (const w of cfg.warnings) console.error(`warning: ${w}`);
  for (const e of cfg.errors) console.error(`error: ${e}`);
}

async function main() {
  switch (cmd) {
    case 'start': {
      const cfg = load();
      printProblems(cfg);
      if (cfg.errors.length) { console.error('Fix the errors above (see: helm config).'); return 1; }
      // server.mjs applies the file itself, after .env (env > .env > file > defaults)
      await import('../server.mjs');
      return null; // keep running
    }
    case 'config': {
      if (args[0] === 'init') {
        const target = path.resolve(ROOT, process.env.HELM_CONFIG || 'helm.config.json');
        if (existsSync(target)) { console.error(`${target} already exists; not overwriting.`); return 0; }
        const o = {};
        for (const s of SCHEMA) { const [a, b] = s.key.split('.'); (o[a] ??= {})[b] = s.default; }
        writeFileSync(target, JSON.stringify(o, null, 2) + '\n');
        console.log(`created ${target}`);
        return 0;
      }
      const cfg = load();
      const rows = describeConfig(cfg);
      if (flags.has('--json')) {
        console.log(JSON.stringify({ file: cfg.file, fileLoaded: cfg.fileLoaded, errors: cfg.errors, warnings: cfg.warnings, settings: rows }, null, 2));
      } else {
        printProblems(cfg);
        const w = (f) => Math.max(...rows.map((r) => String(r[f]).length));
        const wk = w('key'), we = w('env'), wv = Math.min(40, Math.max(5, ...rows.map((r) => JSON.stringify(r.value).length)));
        console.log(`config file: ${cfg.file}${cfg.fileLoaded ? '' : ' (not present)'}`);
        for (const r of rows) console.log(`${r.key.padEnd(wk)}  ${r.env.padEnd(we)}  ${JSON.stringify(r.value).slice(0, wv).padEnd(wv)}  ${r.source}`);
      }
      return cfg.errors.length ? 1 : 0;
    }
    case 'doctor': return doctor() > 0 ? 1 : 0;
    case 'version': case '--version': case '-v':
      console.log(JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version); return 0;
    case 'help': case '--help': case '-h': console.log(HELP); return 0;
    default: console.error(`unknown command: ${cmd}\n\n${HELP}`); return 2;
  }
}

function which(bin) {
  if (bin.includes('/')) return existsSync(bin) ? bin : null;
  for (const d of (process.env.PATH || '').split(path.delimiter)) { const p = path.join(d, bin); if (d && existsSync(p)) return p; }
  return null;
}

// engine/requirements.txt: one `name==version` per line, `#` comments. Shared with scripts/setup.sh and /api/health.
function readRequirements() {
  const f = path.join(ROOT, 'engine', 'requirements.txt');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').map((l) => l.replace(/#.*/, '').trim()).filter(Boolean)
    .map((l) => { const [name, version = ''] = l.split('=='); return { name: name.trim(), version: version.trim() }; });
}

// returns "name (have X, want Y)" for every package that is missing or at another version
function pythonMismatches(py, reqs) {
  const code = 'import sys, json, importlib.metadata as m\nout = {}\nfor n in sys.argv[1:]:\n    try: out[n] = m.version(n)\n    except Exception: out[n] = None\nprint(json.dumps(out))';
  const r = spawnSync(py, ['-I', '-c', code, ...reqs.map((x) => x.name)], { encoding: 'utf8', timeout: 30000 });
  let have = {};
  try { have = JSON.parse(r.stdout); } catch { return ['could not run engine/.venv/bin/python']; }
  return reqs.filter((x) => have[x.name] !== x.version).map((x) => `${x.name} (have ${have[x.name] || 'none'}, want ${x.version})`);
}

function doctor() {
  const cfg = load();
  const results = [];
  const add = (name, ok, detail, fix, required = true) => results.push({ name, ok, detail, fix, required });
  const major = Number(process.versions.node.split('.')[0]);
  add('Node >= 20', major >= 20, `v${process.versions.node}`, 'Install Node 20 or newer (https://nodejs.org).');
  const claudeBin = cfg.values['claude.bin'] || 'claude';
  const claude = which(claudeBin);
  let cv = '';
  if (claude) { const r = spawnSync(claude, ['--version'], { encoding: 'utf8', timeout: 10000 }); cv = (r.stdout || '').trim(); }
  add('claude command', Boolean(claude), claude ? `${claude} ${cv}` : `"${claudeBin}" not found`,
    'curl -fsSL https://claude.ai/install.sh | bash  (or: npm install -g @anthropic-ai/claude-code), run `claude` to log in, then restart Helm; or set claude.bin / CLAUDE_BIN to its absolute path.');
  const dotnetBin = cfg.values['engine.dotnetBin'] || path.join(os.homedir(), '.dotnet', 'dotnet');
  const dn = which(dotnetBin);
  add('dotnet', Boolean(dn), dn || `${dotnetBin} not found`,
    'curl -sSL https://dot.net/v1/dotnet-install.sh | bash -s -- --channel 10.0 --install-dir ~/.dotnet  (or set engine.dotnetBin / DOTNET_BIN)');
  const dll = path.join(ROOT, 'engine', 'Lean', 'Launcher', 'bin', 'Release', 'QuantConnect.Lean.Launcher.dll');
  add('LEAN launcher built', existsSync(dll), existsSync(dll) ? 'engine/Lean/Launcher/bin/Release' : 'QuantConnect.Lean.Launcher.dll missing',
    'scripts/setup.sh  (downloads the pinned LEAN commit into engine/Lean and builds it with ~/.dotnet/dotnet build engine/Lean/Launcher/QuantConnect.Lean.Launcher.csproj -c Release)');
  const py = path.join(ROOT, 'engine', '.venv', 'bin', 'python');
  const pipFix = 'uv pip install --python engine/.venv/bin/python -r engine/requirements.txt';
  add('engine/.venv python', existsSync(py), existsSync(py) ? 'engine/.venv/bin/python' : 'engine/.venv/bin/python missing',
    `uv venv --python 3.11 engine/.venv && ${pipFix}`);
  if (existsSync(py)) {
    const reqs = readRequirements();
    const bad = reqs.length ? pythonMismatches(py, reqs) : ['engine/requirements.txt missing'];
    add('Python packages (engine/requirements.txt)', bad.length === 0, bad.length ? bad.join(', ') : `${reqs.length} pinned packages`, pipFix);
  }
  add('config valid', cfg.errors.length === 0, cfg.errors.length ? cfg.errors.join('; ') : `${cfg.fileLoaded ? cfg.file : 'defaults + env'}${cfg.warnings.length ? ` (${cfg.warnings.length} warning(s))` : ''}`,
    'Run `helm config` and fix the listed errors.');
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`);
    if (!r.ok) { console.log(`      fix: ${r.fix}`); if (r.required) failed++; }
  }
  for (const w of cfg.warnings) console.log(`warn  ${w}`);
  console.log(failed ? `\n${failed} required check(s) failed` : '\nall checks passed');
  return failed;
}

const code = await main();
if (code !== null) process.exit(code);
