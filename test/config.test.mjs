// 配置系统：默认值 < 配置文件 < 环境变量；类型/范围错误、未知键提示、坏 JSON、applyToEnv 不覆盖、密钥脱敏、CLI。
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, applyToEnv, describeConfig, SCHEMA } from '../lib/config.mjs';

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed++; };

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'helm.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'helm-config-'));
const write = (name, text) => { const f = path.join(tmp, name); writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); return f; };
const load = (file, env = {}) => loadConfig({ root: tmp, env, file });

// 默认值
{
  const c = load(path.join(tmp, 'nope.json'));
  check('默认值：端口 4377，来源 default', c.values['server.port'] === 4377 && c.sources['server.port'] === 'default');
  check('文件不存在不报错（显式指定的会有警告）', c.errors.length === 0 && c.warnings.length === 1 && !c.fileLoaded);
  const d = loadConfig({ root: tmp, env: {} });
  check('没有文件也没指定：无错误无警告', d.errors.length === 0 && d.warnings.length === 0);
  check('每个设置都有中英文说明和环境变量名', SCHEMA.every((s) => s.en && s.zh && s.env && s.key.includes('.')));
  check('key 和环境变量名都不重复', new Set(SCHEMA.map((s) => s.key)).size === SCHEMA.length && new Set(SCHEMA.map((s) => s.env)).size === SCHEMA.length);
}
// 文件覆盖默认；环境变量覆盖文件
{
  const f = write('a.json', { server: { port: 5000 }, agents: { maxRuns: 3 }, engine: { dotnetBin: 'bin/dotnet' } });
  const c = load(f);
  check('文件覆盖默认值', c.values['server.port'] === 5000 && c.sources['server.port'] === 'file' && c.values['agents.maxRuns'] === 3);
  check('文件里的相对路径按文件所在目录解析', c.values['engine.dotnetBin'] === path.join(tmp, 'bin/dotnet'), c.values['engine.dotnetBin']);
  const e = load(f, { PORT: '6000' });
  check('环境变量覆盖文件', e.values['server.port'] === 6000 && e.sources['server.port'] === 'env' && e.sources['agents.maxRuns'] === 'file');
  const h = loadConfig({ root: tmp, env: { HELM_CONFIG: f } });
  check('HELM_CONFIG 指定配置文件位置', h.values['server.port'] === 5000);
  const empty = load(f, { PORT: '' });
  check('空字符串的环境变量当作没设', empty.values['server.port'] === 5000);
}
// 类型 / 范围错误
{
  const c = load(write('b.json', { server: { port: 70000 }, agents: { maxRuns: 'three' }, claude: { effort: 'ultra' } }));
  check('端口超范围：报错并写明范围', c.errors.some((m) => m.startsWith('server.port') && m.includes('1..65535')), c.errors[0]);
  check('类型不对：报错并点名 key', c.errors.some((m) => m.startsWith('agents.maxRuns')));
  check('枚举不在允许值里：报错并列出允许值', c.errors.some((m) => m.startsWith('claude.effort') && m.includes('low')));
  check('出错的设置保留默认值', c.values['server.port'] === 4377);
  const e = load(path.join(tmp, 'nope.json'), { PORT: 'abc', HELM_MAX_RUNS: '0' });
  check('环境变量的类型和范围也检查', e.errors.length === 2 && e.errors[0].includes('PORT'), e.errors.join(' | '));
}
// 未知键
{
  const c = load(write('c.json', { server: { prot: 1 }, agent: { maxRuns: 2 }, claude: { bin: 'claude' } }));
  check('未知键：警告而不是错误', c.errors.length === 0 && c.warnings.length === 2, c.warnings.join(' | '));
  check('未知键：给出 did you mean', c.warnings.some((w) => w.includes('server.prot') && w.includes('did you mean "server.port"')) && c.warnings.some((w) => w.includes('agent.maxRuns') && w.includes('agents.maxRuns')));
}
// 坏 JSON
{
  const f = write('d.json', '{ "server": ');
  const c = load(f);
  check('坏 JSON：错误里有文件路径，不抛异常', c.errors.length === 1 && c.errors[0].includes(f) && c.errors[0].includes('invalid JSON'), c.errors[0]);
  check('坏 JSON：其余设置仍是默认值', c.values['server.port'] === 4377);
}
// applyToEnv
{
  const c = load(write('e.json', { server: { port: 5001 }, agents: { maxRuns: 2 }, claude: { bin: 'myclaude' } }), { HELM_MAX_RUNS: '5' });
  const env = { PORT: '9999' }; // 已有的 PORT 不能被文件覆盖
  const applied = applyToEnv(c, env);
  check('applyToEnv 不覆盖已有的环境变量', env.PORT === '9999' && env.HELM_MAX_RUNS === undefined);
  check('applyToEnv 只写来自文件的设置', env.CLAUDE_BIN === 'myclaude' && applied.length === 1 && applied[0] === 'CLAUDE_BIN', applied.join());
  const env2 = {}; applyToEnv(load(write('e2.json', { server: { port: 5002 } })), env2);
  check('applyToEnv 把数字写成字符串', env2.PORT === '5002' && Object.keys(env2).length === 1);
}
// 自定义 schema：bool / 密钥脱敏
{
  const schema = [
    { key: 'x.flag', env: 'X_FLAG', type: 'bool', default: false, en: 'f', zh: '旗' },
    { key: 'x.token', env: 'X_TOKEN', type: 'string', default: '', secret: true, en: 't', zh: '令牌' },
  ];
  const c = loadConfig({ root: tmp, env: { X_FLAG: 'yes', X_TOKEN: 'sekret-123' }, file: path.join(tmp, 'nope.json'), schema });
  check('bool 接受 yes/true/1', c.values['x.flag'] === true);
  const rows = describeConfig(c);
  const tok = rows.find((r) => r.key === 'x.token');
  check('密钥在 describeConfig 里脱敏', tok.value === '********' && !JSON.stringify(rows).includes('sekret-123'));
  check('密钥为空时不显示星号', describeConfig(loadConfig({ root: tmp, env: {}, file: path.join(tmp, 'nope.json'), schema })).find((r) => r.key === 'x.token').value === '');
  const bad = loadConfig({ root: tmp, env: { X_FLAG: 'maybe' }, file: path.join(tmp, 'nope.json'), schema });
  check('bool 非法值报错', bad.errors.length === 1);
  const real = describeConfig(load(path.join(tmp, 'nope.json'), { QS_SEC_USER_AGENT: 'Me me@example.com' }));
  check('真实 SCHEMA 里 SEC User-Agent 被脱敏', real.find((r) => r.key === 'qlib.secUserAgent').value === '********');
}
// CLI
{
  const f = write('cli.json', { server: { port: 5123 } });
  const env = { ...process.env, HELM_CONFIG: f };
  delete env.PORT;
  const r = spawnSync(process.execPath, [BIN, 'config', '--json'], { env, encoding: 'utf8' });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  const port = j && j.settings.find((s) => s.key === 'server.port');
  check('CLI config --json：退出码 0，端口来自文件', r.status === 0 && port && port.value === 5123 && port.source === 'file', r.stderr.trim());
  const bad = spawnSync(process.execPath, [BIN, 'config', '--json'], { env: { ...env, HELM_CONFIG: write('cli2.json', { server: { port: 0 } }) }, encoding: 'utf8' });
  check('CLI config：配置有错时退出码 1', bad.status === 1);
  const v = spawnSync(process.execPath, [BIN, 'version'], { encoding: 'utf8' });
  check('CLI version 输出版本号', v.status === 0 && /^\d+\.\d+\.\d+/.test(v.stdout));
  const init = spawnSync(process.execPath, [BIN, 'config', 'init'], { env: { ...env, HELM_CONFIG: path.join(tmp, 'init.json') }, encoding: 'utf8' });
  const again = spawnSync(process.execPath, [BIN, 'config', 'init'], { env: { ...env, HELM_CONFIG: path.join(tmp, 'init.json') }, encoding: 'utf8' });
  check('CLI config init 创建文件，再跑一次不覆盖', init.stdout.includes('created') && again.stderr.includes('not overwriting'));
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
