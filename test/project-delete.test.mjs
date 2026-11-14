// 删除项目：移到 .trash 而不是抹掉；有回测在跑时拒绝；编号不复用；列表里看不到
import { mkdtempSync, existsSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'helm-pdel-'));
process.env.HELM_PROJECTS_DIR = tmp;
try {
  const E = await import('../lib/engine.mjs');
  const a = (await E.createProject({ name: 'A' })).projects[0].projectId;
  const b = (await E.createProject({ name: 'B' })).projects[0].projectId;
  // 运行中的回测挡住删除
  const bt = path.join(tmp, String(b), 'backtests', 'x1');
  mkdirSync(bt, { recursive: true });
  writeFileSync(path.join(bt, 'meta.json'), JSON.stringify({ status: 'In Progress...' }));
  assert.equal((await E.trashProject({ projectId: b })).success, false);
  writeFileSync(path.join(bt, 'meta.json'), JSON.stringify({ status: 'Completed.' }));
  const r = await E.trashProject({ projectId: b });
  assert.equal(r.success, true);
  assert.ok(!existsSync(path.join(tmp, String(b))));
  assert.equal(readdirSync(path.join(tmp, '.trash')).length, 1);
  assert.deepEqual((await E.listProjects()).map((p) => p.projectId), [a]);
  const c = (await E.createProject({ name: 'C' })).projects[0].projectId;
  assert.ok(c > b, '回收站里的编号不复用');
  assert.equal((await E.trashProject({ projectId: 9999 })).success, false);
  console.log('project-delete: 移到回收站、运行中拒绝、编号不复用 ✓');
} finally { rmSync(tmp, { recursive: true, force: true }); }
