// 一键生成研发汇报：数据包 → 策划（大纲，等用户确认）→ 撰写 → 评审 → 修改 → 数字核对 → 渲染 pptx → 转 PDF
// 四个角色的分工和评审标准改编自 deck-pipeline / mckinsey-critic 两个技能（MIT，Copyright (c) 2025 Sruthi Reddy），
// 见 THIRD_PARTY_NOTICES.md。数字规则是 Helm 自己加的：模型只写叙述和占位符，数字全部由 Helm 的回测数据填。
import { readFile, writeFile, mkdir, readdir, rm, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { packForModel } from './datapack.mjs';
import { checkDeck, describeIssues, LIMITS } from './check.mjs';

export const QUALITY = { standard: 'sonnet', best: 'opus' };
const STAGES = ['data', 'outline', 'build', 'review', 'fix', 'render', 'pdf'];

const DISCLAIMER = {
  zh: '本材料仅供专业投资者参考，不构成任何投资建议或要约。\n文中业绩为回测得出的假设业绩，并非实际交易结果；回测基于历史数据，存在前视、过拟合等局限，不代表未来表现。\n验证期结果只运行一次；模拟实盘为纸面交易，不涉及真实资金。',
  en: 'This material is for professional investors only and is not investment advice or an offer.\nPerformance shown is hypothetical and comes from backtests, not actual trading. Backtests rely on historical data and are subject to look-ahead and overfitting risk; they do not predict future results.\nHoldout results were run once. Paper trading uses no real money.',
};

/* ---------------- 提示词 ---------------- */

const langName = (lang) => (lang === 'en' ? 'English' : 'Simplified Chinese');

const AUDIENCE = {
  team: `AUDIENCE: the internal investment team (research review).
- Be candid. Say what failed and why. Development and holdout results side by side.
- Debug or candidate runs may appear when they explain a decision.
- Next steps are concrete: what to keep, what to stop, what to test next.`,
  client: `AUDIENCE: clients / investors (external).
- Professional and measured. No internal jargon: never mention run ids, "debug", "candidate", file names or tool names; call versions by plain names.
- Always show holdout (out-of-sample) results next to development results, and say how many versions were tried ({{trials}} when available).
- Say "backtested" / "hypothetical". Never promise or forecast returns.
- Do not hide bad news: if the holdout failed, say so plainly and say what you are doing about it.
- A compliance disclaimer page is appended automatically; do not write one.`,
};

const NUMBERS = `NUMBER RULE (strict):
- Never type a performance number yourself. Every number must be a placeholder {{key}} where key is one of the keys in "facts" (e.g. {{b1.cagr}}, {{b2.maxdd}}, {{trials}}). Helm replaces placeholders with the verified value.
- Years, "100" as the index start, index names (S&P 500) and small counts are fine as plain text.
- If the data has no number for something, write the sentence without a number. Never estimate, round or derive numbers.
- Text claims must agree with the facts: do not say a strategy "beat" the benchmark if its excess is negative, etc.`;

const LAYOUTS = `SLIDE SPEC FORMAT (JSON). Top level: {"title": deck title, short, "subtitle": the one-line answer, "sections": [3–6 short section names], "slides": [...]}
Cover, agenda, appendix (data sources and run fingerprints) and disclaimer are added automatically. Do not create them.
Every slide: "layout", "section" (index into sections), "title" (a CLAIM sentence that states the conclusion, not a label; ≤ ${LIMITS.title} characters), "subtitle" (one line that supports the claim), optional "takeaway" (one line, shown in a highlight box at the bottom: the so-what), optional "source".
Text fields may use **bold**. Bullets: short, one idea each, ≤ ${LIMITS.bullet} characters.
Layouts:
- exec_summary: "columns": [2–3 × {"heading", "bullets": [3–4], "verdict": short line, "tone": "positive"|"neutral"|"negative"}], "verdict": the overall conclusion, "verdictTone": "positive"|"negative".
- chart: "chart": CHART, "chartTitle", optional side panel "sideTitle" + "bullets" [2–4].
- two_charts: "left" and "right": {"heading", "chart": CHART, "note": one line under the chart}.
- kpis: "kpis": [3–5 × {"value": "{{b1.cagr}}", "label", "highlight": true on at most one}], optional "chart" + "chartTitle", optional "bullets".
- table: "table": TABLE, optional "tableTitle", optional side panel "sideTitle" + "bullets".
- bullets: "panels": [1–3 × {"heading", "bullets": [3–5]}]. Use only when nothing quantitative fits.
- divider: only "title". A section break; only for decks longer than 10 slides.
CHART (native, editable PowerPoint charts drawn from Helm's data):
  {"type":"equity","bt":"b1"} growth of 100 vs benchmark
  {"type":"drawdown","bt":"b1"} drawdown vs benchmark
  {"type":"annual","bt":"b1"} calendar-year returns vs benchmark
  {"type":"metric_bars","bts":["b1","b2"],"metric":M,"highlight":"b1"} one metric across versions
  {"type":"excess_bridge","bt":"b1"} benchmark CAGR → excess → strategy CAGR
TABLE:
  {"kind":"gates","bt":"b1"} the statistical checks, pass/fail
  {"kind":"compare","bts":["b1","b2"],"metrics":[M,...],"highlight":"b1"} versions side by side
  {"kind":"monthly","bt":"b1"} monthly return heatmap
  {"kind":"custom","header":[...],"rows":[[...],...]} text only (no numbers except placeholders)
M is one of: cagr, net, sharpe, maxdd, excess, vol, winrate, trades, dsr, benchCagr, benchMaxdd.
Prefer a chart or table over bullets on every quantitative slide. Use each chart at most once.`;

function strategistPrompt(o) {
  return `You are the STRATEGIST of a four-person deck team at a quantitative investment firm. You design the narrative of a research-results presentation before anything is built.
Input: a JSON data pack with the project, its backtests (b1, b2…; "period" dev = development, holdout = out-of-sample run once), statistical checks, paper trading (p1…), research notes and "facts" (verified numbers).
${AUDIENCE[o.audience] || AUDIENCE.team}
Work like a top consulting team:
- Define the governing thought: the one sentence the whole deck proves. It must be supported by the data, including bad news.
- Situation → Complication → Resolution. Group slides into 3–6 sections.
- ${o.length === 'short' ? '6–8' : '9–12'} content slides. Every title is a claim, not a topic ("Holdout returns lagged the S&P 500 by {{b1.excess}} a year", not "Holdout results").
- Pick a layout and visual for each slide from the format below. Lead with an exec_summary slide.
${NUMBERS}
${LAYOUTS}
${o.notes ? `USER NOTES (follow them): ${o.notes}\n` : ''}Write all text in ${langName(o.lang)}.
Reply with JSON only, no prose:
{"audience": "...", "governingThought": "...", "storyline": "situation / complication / resolution in one line each", "sections": ["..."], "slides": [{"section": 0, "layout": "...", "title": "claim", "points": ["what the slide shows"], "visual": "e.g. chart equity b1"}]}`;
}

function builderPrompt(o) {
  return `You are the BUILDER of a four-person deck team at a quantitative investment firm. Turn the approved outline into the full slide spec.
${AUDIENCE[o.audience] || AUDIENCE.team}
- Keep the outline's governing thought, order and claims; sharpen wording where needed.
- Each slide has a clear so-what (takeaway). Body text 3–5 points max. Every data slide has a source line (e.g. "Helm backtest b1 (LEAN)").
${NUMBERS}
${LAYOUTS}
${o.notes ? `USER NOTES (follow them): ${o.notes}\n` : ''}Write all text in ${langName(o.lang)}.
Reply with the slide spec JSON only.`;
}

function criticPrompt(o) {
  return `You are the CRITIC: a McKinsey engagement manager reviewing a deck at 2am before it goes to ${o.audience === 'client' ? 'clients' : 'the investment team'}. Be specific and adversarial; you are not protecting what was built.
Input: {"deck": the slide spec with numbers filled in, "facts": the verified numbers, "backtests": run summaries, "numberCheck": problems Helm's automatic check found}.
Check:
- Structure: does the storyline flow? Can someone read only the titles and get the full argument?
- Claims: is every title a claim? Is every claim supported by the facts? Flag any statement that contradicts the facts (e.g. says it outperformed when excess is negative), and anything that overstates certainty.
- So-what: does every slide have one?
- Visuals: lists where a chart or table belongs, duplicated charts, slides that say the same thing.
- ${o.audience === 'client' ? 'Client rules: holdout shown, trials disclosed, no jargon, no promises.' : 'Team rules: failures explained, next steps concrete.'}
Grades: green = ready; yellow = fixable, do not send as-is; red = core argument broken.
Write all text in ${langName(o.lang)}.
Reply with JSON only:
{"grade": "green|yellow|red", "verdict": "one line", "slides": [{"index": 0, "status": "green|yellow|red", "issue": "specific issue or 'Strong'"}], "fixes": [{"title": "...", "instruction": "exactly what to change, on which slide"}], "factCheck": [{"slide": 0, "claim": "...", "problem": "..."}], "works": "one thing that works and should be protected"}
"fixes" has the top 3 by impact. In "slides", "index" 0 is the first content slide. When your text mentions a slide, use the page number the reader sees: page = index + 3 (the cover and contents come first), e.g. "page 5".`;
}

function fixerPrompt(o) {
  return `You are the FIXER. Apply the critic's top fixes, every fact-check problem and every number-check problem to the slide spec. Change nothing else; protect what the critic said works.
${NUMBERS}
${LAYOUTS}
Write all text in ${langName(o.lang)}.
When "changes" mentions a slide, use the page number the reader sees (first content slide = page 3).
Reply with JSON only: {"spec": the full revised slide spec, "changes": ["page N: before → after, one line each"]}`;
}

/** 从模型回复里取 JSON（容忍 \`\`\`json 包裹和前后的废话） */
export function extractJson(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : s;
  try { return JSON.parse(body); } catch { /* 往下找第一个 { 到最后一个 } */ }
  const a = body.indexOf('{'); const b = body.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(body.slice(a, b + 1));
  throw new Error('no JSON in reply');
}

/* ---------------- 服务 ---------------- */

export function findSoffice() {
  const c = [process.env.HELM_SOFFICE, '/Applications/LibreOffice.app/Contents/MacOS/soffice', '/opt/homebrew/bin/soffice', '/usr/local/bin/soffice', '/usr/bin/soffice'];
  return c.find((p) => p && existsSync(p)) || null;
}

function run(cmd, args, { cwd, timeoutMs = 300_000, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * DeckService：管理所有汇报任务。
 * deps: { projectsDir, dataDir, python, rendererDir, runModel({system,input,model}) → text, buildDataPack, onUpdate(job) }
 */
export class DeckService {
  constructor(deps) {
    this.d = deps;
    this.active = new Map();     // deckId → 正在跑的 promise
    this.renderChain = Promise.resolve();   // soffice 一次只跑一个
    this.settingsFile = path.join(deps.dataDir, 'settings.json');
  }

  dir(projectId, deckId) {
    if (!/^\d+$/.test(String(projectId)) || !/^[a-z0-9-]+$/.test(String(deckId))) throw new Error('bad id');
    return path.join(this.d.projectsDir, String(projectId), 'decks', String(deckId));
  }

  async readJson(file, fallback = null) {
    try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
  }

  async writeJson(file, data) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file + '.tmp', JSON.stringify(data, null, 1));
    await rename(file + '.tmp', file);
  }

  /* ---------- 公司设置（模板、logo、免责声明） ---------- */

  async settings() {
    const s = await this.readJson(this.settingsFile, {});
    return { firm: '', presenter: '', disclaimer: '', disclaimerEn: '', logo: null, template: null, templateName: null, ...s };
  }

  async saveSettings(patch) {
    const cur = await this.settings();
    const next = { ...cur };
    for (const k of ['firm', 'presenter', 'disclaimer', 'disclaimerEn']) if (typeof patch[k] === 'string') next[k] = patch[k].slice(0, 4000);
    if (patch.clearTemplate) {
      await rm(path.join(this.d.dataDir, 'template'), { recursive: true, force: true });
      next.template = null; next.templateName = null;
    }
    if (patch.clearLogo) {
      if (cur.logo) await rm(path.join(this.d.dataDir, cur.logo), { force: true });
      next.logo = null;
    }
    await this.writeJson(this.settingsFile, next);
    return next;
  }

  /** 上传模板：.pptx / .potx / .pdf。分析配色和字体，存到 dataDir/template/ */
  async uploadTemplate(name, buf) {
    const ext = path.extname(String(name)).toLowerCase();
    if (!['.pptx', '.potx', '.pdf'].includes(ext)) throw new Error('unsupported');
    if (buf.length > 60 * 1024 * 1024) throw new Error('too large');
    const tdir = path.join(this.d.dataDir, 'template');
    const tmp = tdir + '.new';
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    const src = path.join(tmp, 'source' + ext);
    await writeFile(src, buf);
    const r = await run(this.d.python, ['-I', path.join(this.d.rendererDir, 'template.py'), src, tmp], { timeoutMs: 120_000 });
    let info;
    try { info = JSON.parse(r.out.trim().split('\n').pop()); } catch { info = null; }
    if (!info || !info.ok) { await rm(tmp, { recursive: true, force: true }); throw new Error((r.err || r.out || 'template analysis failed').slice(-400)); }
    await rm(tdir, { recursive: true, force: true });
    await rename(tmp, tdir);
    const cur = await this.settings();
    await this.writeJson(this.settingsFile, { ...cur, template: info, templateName: path.basename(String(name)).slice(0, 120) });
    return info;
  }

  async uploadLogo(name, buf) {
    const ext = path.extname(String(name)).toLowerCase();
    if (!['.png', '.jpg', '.jpeg'].includes(ext)) throw new Error('unsupported');
    if (buf.length > 5 * 1024 * 1024) throw new Error('too large');
    const cur = await this.settings();
    if (cur.logo) await rm(path.join(this.d.dataDir, cur.logo), { force: true });
    const file = 'logo' + ext;
    await mkdir(this.d.dataDir, { recursive: true });
    await writeFile(path.join(this.d.dataDir, file), buf);
    await this.writeJson(this.settingsFile, { ...cur, logo: file });
    return file;
  }

  templateFile(name) {
    const ok = { preview: 'preview.png' }[name];
    return ok ? path.join(this.d.dataDir, 'template', ok) : null;
  }

  /* ---------- 任务 ---------- */

  async list(projectId) {
    const base = path.join(this.d.projectsDir, String(projectId), 'decks');
    let ids = [];
    try { ids = await readdir(base); } catch { return []; }
    const out = [];
    for (const id of ids) {
      const j = await this.readJob(projectId, id);
      if (j) out.push(this.summary(j));
    }
    return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  summary(j) {
    return {
      deckId: j.deckId, projectId: j.projectId, status: j.status, stage: j.stage, title: j.title || null,
      createdAt: j.createdAt, updatedAt: j.updatedAt, options: j.options, grade: j.review?.grade || null,
      files: j.files || {}, pages: j.pages || 0, error: j.error || null, warnings: (j.warnings || []).length, issues: (j.issues || []).length,
    };
  }

  async readJob(projectId, deckId) {
    let dir;
    try { dir = this.dir(projectId, deckId); } catch { return null; }
    // 先看任务在不在跑，再读文件：读的时候任务可能刚好结束（最后一次保存之后才移出 active），
    // 先读后查会把读到的旧「进行中」误判成中断
    const live = this.active.has(deckId);
    const j = await this.readJson(path.join(dir, 'job.json'));
    if (!j) return null;
    // 服务重启后，原来「进行中」的任务已经没人在跑了
    if (j.status === 'running' && !live && !this.active.has(deckId)) { j.status = 'error'; j.error = 'interrupted'; }
    return j;
  }

  async read(projectId, deckId) {
    const j = await this.readJob(projectId, deckId);
    if (!j) return null;
    const dir = this.dir(projectId, deckId);
    return { ...j, outline: await this.readJson(path.join(dir, 'outline.json')), review: await this.readJson(path.join(dir, 'review.json')) };
  }

  async save(j) {
    j.updatedAt = new Date().toISOString();
    await this.writeJson(path.join(this.dir(j.projectId, j.deckId), 'job.json'), j);
    try { this.d.onUpdate?.(this.summary(j)); } catch { /* 通知失败不影响任务 */ }
  }

  async step(j, stage, msg) {
    j.stage = stage;
    j.log = [...(j.log || []), { at: new Date().toISOString(), stage, msg: msg || null }].slice(-60);
    await this.save(j);
  }

  async create(projectId, opts = {}) {
    const o = {
      audience: opts.audience === 'client' ? 'client' : 'team',
      lang: opts.lang === 'en' ? 'en' : 'zh',
      quality: QUALITY[opts.quality] ? opts.quality : 'standard',
      length: opts.length === 'short' ? 'short' : 'standard',
      backtestIds: Array.isArray(opts.backtestIds) ? opts.backtestIds.filter((x) => /^[a-z0-9-]+$/i.test(String(x))).slice(0, 6) : null,
      notes: String(opts.notes || '').slice(0, 2000),
      reviewOutline: opts.reviewOutline !== false,
    };
    const now = new Date();
    const deckId = `${now.toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')}-${crypto.randomBytes(2).toString('hex')}`;
    const j = { deckId, projectId: String(projectId), status: 'running', stage: 'data', createdAt: now.toISOString(), options: o, log: [], warnings: [], issues: [], files: {} };
    await mkdir(this.dir(projectId, deckId), { recursive: true });
    await this.save(j);
    this.spawn(j, () => this.runOutline(j));
    return this.summary(j);
  }

  spawn(j, fn) {
    const p = fn().catch(async (e) => {
      j.status = 'error';
      j.error = String(e && e.message || e).slice(0, 600);
      await this.save(j).catch(() => {});
    }).finally(() => this.active.delete(j.deckId));
    this.active.set(j.deckId, p);
    return p;
  }

  async model(system, input, j) {
    const model = QUALITY[j.options.quality] || 'sonnet';
    const text = await this.d.runModel({ system, input: JSON.stringify(input), model });
    try { return extractJson(text); } catch {
      // 回复不是 JSON：带上提醒再问一次
      const again = await this.d.runModel({ system, input: JSON.stringify(input) + '\n\nYour previous reply was not valid JSON. Reply with the JSON only.', model });
      return extractJson(again);
    }
  }

  async runOutline(j, note) {
    const dir = this.dir(j.projectId, j.deckId);
    j.status = 'running'; j.error = null;
    await this.step(j, 'data');
    const pack = await this.d.buildDataPack({ projectId: Number(j.projectId), backtestIds: j.options.backtestIds, lang: j.options.lang });
    await this.writeJson(path.join(dir, 'datapack.json'), pack);
    await this.step(j, 'outline');
    const o = { ...j.options, notes: [j.options.notes, note].filter(Boolean).join('\n') };
    const prev = note ? await this.readJson(path.join(dir, 'outline.json')) : null;
    const input = { data: packForModel(pack), ...(prev ? { previousOutline: prev, change: note } : {}) };
    const outline = await this.model(strategistPrompt(o), input, j);
    if (!outline || !Array.isArray(outline.slides) || !outline.slides.length) throw new Error('outline: empty');
    outline.slides = outline.slides.slice(0, LIMITS.slides);
    // 大纲标题里的占位符先填好给用户看
    const shown = checkDeck({ title: outline.governingThought || '', sections: outline.sections || [], slides: [] }, pack);
    outline.governingThoughtFilled = shown.spec.title;
    outline.storylineFilled = checkDeck({ t: String(outline.storyline || '') }, pack).spec.t;
    outline.slides = outline.slides.map((s) => ({ ...s, titleFilled: checkDeck({ t: s.title }, pack).spec.t, pointsFilled: (s.points || []).map((p) => checkDeck({ t: p }, pack).spec.t) }));
    await this.writeJson(path.join(dir, 'outline.json'), outline);
    j.title = outline.governingThoughtFilled || null;
    if (j.options.reviewOutline) {
      j.status = 'awaiting';
      await this.step(j, 'outline', 'awaiting approval');
      return;
    }
    await this.runBuild(j);
  }

  /** 用户确认大纲后继续（可以附一句修改意见，交给撰写环节） */
  async approve(projectId, deckId, note) {
    const j = await this.readJob(projectId, deckId);
    if (!j) throw new Error('not found');
    if (this.active.has(deckId)) throw new Error('busy');
    if (!['awaiting', 'error'].includes(j.status)) throw new Error('not awaiting');
    j.approvedNote = String(note || '').slice(0, 2000);
    j.status = 'running';
    await this.save(j);
    this.spawn(j, () => this.runBuild(j));
    return this.summary(j);
  }

  /** 重做大纲（带修改意见） */
  async redoOutline(projectId, deckId, note) {
    const j = await this.readJob(projectId, deckId);
    if (!j) throw new Error('not found');
    if (this.active.has(deckId)) throw new Error('busy');
    j.status = 'running';
    await this.save(j);
    this.spawn(j, () => this.runOutline(j, String(note || '').slice(0, 2000)));
    return this.summary(j);
  }

  /** 出错后重试：有确认过的大纲就从撰写开始，否则从头 */
  async retry(projectId, deckId) {
    const j = await this.readJob(projectId, deckId);
    if (!j) throw new Error('not found');
    if (this.active.has(deckId)) throw new Error('busy');
    const hasOutline = existsSync(path.join(this.dir(projectId, deckId), 'outline.json'));
    j.status = 'running'; j.error = null;
    await this.save(j);
    this.spawn(j, () => (hasOutline && j.approvedNote != null ? this.runBuild(j) : this.runOutline(j)));
    return this.summary(j);
  }

  async runBuild(j) {
    const dir = this.dir(j.projectId, j.deckId);
    const pack = await this.readJson(path.join(dir, 'datapack.json'));
    const outline = await this.readJson(path.join(dir, 'outline.json'));
    if (!pack || !outline) throw new Error('missing outline');
    const o = { ...j.options, notes: [j.options.notes, j.approvedNote].filter(Boolean).join('\n') };
    const data = packForModel(pack);
    j.status = 'running'; j.error = null;

    // 撰写
    await this.step(j, 'build');
    const strip = ({ titleFilled, pointsFilled, ...s }) => s;
    let spec = await this.model(builderPrompt(o), { data, outline: { ...outline, slides: outline.slides.map(strip) } }, j);
    let checked = checkDeck(spec, pack, { audience: j.options.audience });

    // 评审
    await this.step(j, 'review');
    const review = await this.model(criticPrompt(o), {
      deck: checked.spec, facts: data.facts, backtests: data.backtests, numberCheck: describeIssues(checked.issues, o.lang),
    }, j);
    await this.writeJson(path.join(dir, 'review.json'), review);

    // 修改：评审不是绿色、或者数字核对有问题才改
    const needFix = (review.grade && review.grade !== 'green') || (review.factCheck || []).length || checked.issues.some((x) => x.kind !== 'schema');
    if (needFix) {
      await this.step(j, 'fix');
      const fixed = await this.model(fixerPrompt(o), {
        spec, fixes: (review.fixes || []).slice(0, 3), factCheck: review.factCheck || [], numberCheck: describeIssues(checked.issues, o.lang), protect: review.works || '', facts: data.facts,
      }, j);
      const next = fixed && fixed.spec && Array.isArray(fixed.spec.slides) ? fixed.spec : null;
      if (next) {
        spec = next;
        checked = checkDeck(spec, pack, { audience: j.options.audience });
        review.changes = fixed.changes || [];
        await this.writeJson(path.join(dir, 'review.json'), review);
      }
    }
    await this.writeJson(path.join(dir, 'deck.source.json'), spec);
    await this.writeJson(path.join(dir, 'deck.json'), checked.spec);
    j.issues = checked.issues;
    j.title = checked.spec.title || j.title;
    j.review = { grade: review.grade || null };

    await this.render(j);
  }

  async renderStyle(j) {
    const st = await this.settings();
    const lang = j.options.lang;
    const style = {
      lang, audience: j.options.audience,
      firm: st.firm || '', presenter: st.presenter || '',
      disclaimer: (lang === 'en' ? st.disclaimerEn : st.disclaimer) || DISCLAIMER[lang],
    };
    if (st.logo) style.logo = path.join(this.d.dataDir, st.logo);
    if (st.template) {
      style.template = st.template;
      const tp = path.join(this.d.dataDir, 'template', 'template.pptx');
      if (st.template.useMaster && existsSync(tp)) style.templatePptx = tp;
    }
    return style;
  }

  /** 只重新渲染（改了模板 / logo 之后用，不再调用模型） */
  async rerender(projectId, deckId) {
    const j = await this.readJob(projectId, deckId);
    if (!j) throw new Error('not found');
    if (this.active.has(deckId)) throw new Error('busy');
    if (!existsSync(path.join(this.dir(projectId, deckId), 'deck.json'))) throw new Error('not built');
    j.status = 'running'; j.error = null;
    await this.save(j);
    this.spawn(j, () => this.render(j));
    return this.summary(j);
  }

  async render(j) {
    const dir = this.dir(j.projectId, j.deckId);
    await this.step(j, 'render');
    await this.writeJson(path.join(dir, 'style.json'), await this.renderStyle(j));
    const r = await run(this.d.python, ['-I', path.join(this.d.rendererDir, 'helm_deck.py'), dir], { timeoutMs: 180_000 });
    let res = null;
    try { res = JSON.parse(r.out.trim().split('\n').pop()); } catch { /* 下面报错 */ }
    if (!res || !res.ok) throw new Error(`render: ${(r.err || r.out).slice(-500)}`);
    j.warnings = res.warnings || [];
    j.files = { pptx: 'deck.pptx' };

    await this.step(j, 'pdf');
    const soffice = this.d.soffice === undefined ? findSoffice() : this.d.soffice;
    if (soffice) {
      // LibreOffice 同一个用户配置只能开一个：用独立的配置目录，并排队。
      // 不加 --headless：macOS 上 headless 用的是 LibreOffice 自己的渲染后端，中英混排的句子里中文会整段丢掉；
      // --invisible 走系统原生后端，不弹窗口。原生后端起不来（比如没有图形界面）再退回 headless。
      const job = this.renderChain.then(async () => {
        const profile = `-env:UserInstallation=file://${path.join(os.tmpdir(), 'helm-soffice-profile')}`;
        const env = { ...process.env, HOME: process.env.HOME || os.homedir() };
        const out = ['--convert-to', 'pdf', '--outdir', dir, path.join(dir, 'deck.pptx')];
        await rm(path.join(dir, 'deck.pdf'), { force: true });
        await run(soffice, [profile, '--invisible', '--norestore', '--nologo', ...out], { timeoutMs: 180_000, env });
        if (!existsSync(path.join(dir, 'deck.pdf'))) await run(soffice, [profile, '--headless', '--norestore', ...out], { timeoutMs: 180_000, env });
      });
      this.renderChain = job.catch(() => {});
      await job;
      if (existsSync(path.join(dir, 'deck.pdf'))) {
        j.files.pdf = 'deck.pdf';
        const pv = await run(this.d.python, ['-I', path.join(this.d.rendererDir, 'preview.py'), path.join(dir, 'deck.pdf'), path.join(dir, 'pages'), '1280'], { timeoutMs: 120_000 });
        try { j.pages = JSON.parse(pv.out.trim().split('\n').pop()).pages || 0; } catch { j.pages = 0; }
      } else j.warnings.push('pdf: conversion failed');
    } else {
      j.warnings.push('pdf: LibreOffice not installed');
    }
    j.status = 'done';
    j.finishedAt = new Date().toISOString();
    await this.step(j, 'done');
  }

  async remove(projectId, deckId) {
    if (this.active.has(deckId)) throw new Error('busy');
    const dir = this.dir(projectId, deckId);
    if (!existsSync(path.join(dir, 'job.json'))) throw new Error('not found');
    await rm(dir, { recursive: true, force: true });
    return true;
  }

  /** 预览图：第 n 页（从 1 开始） */
  async page(projectId, deckId, n) {
    const i = Number(n);
    if (!Number.isInteger(i) || i < 1 || i > 200) return null;
    const f = path.join(this.dir(projectId, deckId), 'pages', `p${String(i).padStart(2, '0')}.png`);
    try { await stat(f); return f; } catch { return null; }
  }

  /** 下载 / 预览用的文件路径（只认 pptx 和 pdf） */
  async file(projectId, deckId, kind) {
    const name = { pptx: 'deck.pptx', pdf: 'deck.pdf' }[kind];
    if (!name) return null;
    const f = path.join(this.dir(projectId, deckId), name);
    try { await stat(f); return f; } catch { return null; }
  }
}

export { STAGES, DISCLAIMER, strategistPrompt, builderPrompt, criticPrompt, fixerPrompt };
