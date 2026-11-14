#!/usr/bin/env node
// 独立的回测进程：由 createBacktest 以 detached 方式启动，跑完把结果写进 meta.json
import { runBacktestJob } from './engine.mjs';

const [projectId, backtestId] = process.argv.slice(2);
if (!projectId || !backtestId) process.exit(2);
await runBacktestJob(projectId, backtestId);
process.exit(0);
