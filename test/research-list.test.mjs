// 回归：想法检验会在 jobs/ 里写 <jobId>.idea.json（规则文件），研究列表不能把它当任务读，否则整页 500
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'helm-rlist-'));
process.env.HELM_PROJECTS_DIR = tmp;
try {
  const jobs = path.join(tmp, '1001', 'research', 'jobs');
  const run = path.join(tmp, '1001', 'research', 'quant_runs', 'X_r26110900000001');
  mkdirSync(jobs, { recursive: true }); mkdirSync(run, { recursive: true });
  const job = { jobId: 'r26110900000001', projectId: 1001, mode: 'idea', title: 't', created: '2026-11-09T00:00:00Z', runDir: run };
  writeFileSync(path.join(jobs, 'r26110900000001.json'), JSON.stringify(job));
  writeFileSync(path.join(jobs, 'r26110900000001.idea.json'), JSON.stringify({ idea: 'x', factors: [] }));
  const Q = await import('../lib/qlib.mjs');
  const r = await Q.listResearch({ projectId: 1001 });
  assert.equal(r.success, true);
  assert.deepEqual(r.jobs.map((j) => j.jobId), ['r26110900000001']);
  console.log('research-list: 规则文件不会被当成任务 ✓');
} finally { rmSync(tmp, { recursive: true, force: true }); }
