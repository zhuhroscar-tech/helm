// 项目的双语名字（nameEn / nameZh）：node test/project-names.test.mjs
// 建项目时可以带两种语言的名字；改名时可以改、可以清空；原来的 name 不受影响；接口和 MCP 工具都认这两个字段
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TMP = await mkdtemp(path.join(os.tmpdir(), 'helm-names-'));
process.env.HELM_PROJECTS_DIR = path.join(TMP, 'projects');
const E = await import('../lib/engine.mjs');
let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };

try {
  const r = await E.createProject({ name: '低波动50只', nameEn: '  Low-vol 50  ', nameZh: '' });
  const p = r.projects[0];
  check('建项目：nameEn 去掉首尾空格，空的 nameZh 不写', p.name === '低波动50只' && p.nameEn === 'Low-vol 50' && !('nameZh' in p), JSON.stringify(p));
  const onDisk = JSON.parse(await readFile(path.join(TMP, 'projects', String(p.projectId), 'project.json'), 'utf8'));
  check('建项目：写进 project.json', onDisk.nameEn === 'Low-vol 50');

  const old = await E.createProject({ name: 'Old project' });
  check('不带双语名字：和以前一样', !('nameEn' in old.projects[0]) && !('nameZh' in old.projects[0]));

  const u = (await E.updateProject({ projectId: p.projectId, nameZh: '低波动 50 只（月度）', nameEn: 'x'.repeat(300) })).projects[0];
  check('改名：nameZh 写入，nameEn 截到 120 字', u.nameZh === '低波动 50 只（月度）' && u.nameEn.length === 120 && u.name === '低波动50只');
  const c = (await E.updateProject({ projectId: p.projectId, nameEn: '' })).projects[0];
  check('改名：传空字符串 = 删掉这个语言的名字，其它不动', !('nameEn' in c) && c.nameZh === '低波动 50 只（月度）');
  const d = (await E.updateProject({ projectId: p.projectId, description: 'only desc' })).projects[0];
  check('只改说明：双语名字保留', d.nameZh === '低波动 50 只（月度）' && d.description === 'only desc');

  const listed = (await E.listProjects()).find((x) => x.projectId === p.projectId);
  check('项目列表带双语名字（网页按界面语言显示）', listed.nameZh === '低波动 50 只（月度）');

  const mcp = await readFile(new URL('../mcp/qc-mcp.mjs', import.meta.url), 'utf8');
  check('MCP create_project / update_project 都有 nameEn、nameZh 参数', /name: 'create_project'[\s\S]*?nameEn:[\s\S]*?nameZh:[\s\S]*?name: 'update_project'[\s\S]*?nameEn: str, nameZh: str/.test(mcp));
  const srv = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  check('agent 提示词要求建项目时给两种语言的名字', /## 项目名[\s\S]{0,200}nameEn[\s\S]{0,40}nameZh/.test(srv));
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const raw = ['<span class="pname">${esc(p.name)}', '<h1>${esc(p ? p.name', '<b>${esc(p.name)}</b>', 'S.project.name :', '<h2>${esc(c.name)}</h2>', 'esc(e.projectName)}</a>'].filter((x) => app.includes(x));
  check('网页：侧栏、首页、项目页、标题、想法记录、流水线都按语言取名', raw.length === 0 && (app.match(/pName(ById)?\(/g) || []).length >= 10, raw.join(' | '));
} catch (e) {
  check('没有异常', false, e.stack);
}
await rm(TMP, { recursive: true, force: true });
console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
