// 数据翻译：用户 / agent 写的内容（项目说明、回测名、规则说明、想法、对话、研究结论……）按界面语言显示。
//
// 界面上固定的文字有字典（public/i18n-dict.js、lib/i18n.mjs）；这里管的是「数据」：没法提前翻，只能用模型翻。
//  - 中文界面看到英文内容 → 翻成中文；英文界面看到中文内容 → 翻成英文
//  - 每段原文只翻一次，结果存 data/i18n/translations.json（按 目标语言 + 原文的 SHA-1 存），以后直接用
//  - 接口返回时只查缓存（同步、不等）：没翻过的先原样返回，同时排进后台队列；翻完通知网页重新取一次
//  - 翻译失败（没连 AI、额度用完……）就一直显示原文，10 分钟后再试
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CJK = /[㐀-鿿]/;
const MAX_TEXT = 40_000;     // 再长的不翻（整段日志之类，本来也不该进来）
const BATCH_CHARS = 12_000;  // 一批最多这么多字符
const BATCH_ITEMS = 60;
const RETRY_MS = 10 * 60_000;
const MAX_ENTRIES = 50_000;

/** 这段文字需不需要翻成 target 语言 */
export function needsTranslation(text, target) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  if (!t || t.length > MAX_TEXT) return false;
  if (target === 'en') return CJK.test(t);
  if (target === 'zh') {
    if (CJK.test(t) || /^https?:\/\//.test(t)) return false;
    // 至少 3 个英文单词才算「一句英文」：SPY、lowvol252、main.py、IC 这种代码 / 代号不翻
    return (t.match(/[A-Za-z]{2,}/g) || []).length >= 3 && !/^[\w.\-/]+$/.test(t);
  }
  return false;
}

const keyOf = (text, target) => `${target}:${crypto.createHash('sha1').update(text).digest('hex')}`;

export class Translator {
  /**
   * runBatch(texts, target) → Promise<string[]>：同样长度、同样顺序；失败就抛错
   * onUpdate()：有新译文进缓存时调用（用来通知网页重新取数据）
   */
  constructor({ file, runBatch, onUpdate = () => {}, delayMs = 600, concurrency = 2 }) {
    this.file = file;
    this.runBatch = runBatch;
    this.onUpdate = onUpdate;
    this.delayMs = delayMs;
    this.concurrency = concurrency;
    this.cache = new Map();
    this.queue = new Map();      // key -> { text, target, single }
    this.failedUntil = new Map(); // key -> 时间戳
    this.inFlight = new Set();   // 正在翻的 key
    this.running = 0;
    this.timer = null;
    this.saveTimer = null;
    this.enabled = true;
    this.fails = 0;            // 连续失败次数：没连 AI 时别一条一条地狂试
    this.pausedUntil = 0;
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j.entries || {})) if (typeof v === 'string') this.cache.set(k, v);
    } catch { /* 第一次用：没有缓存文件 */ }
  }

  /** 查译文：有就返回，没有就排队并返回 null */
  lookup(text, target) {
    if (!needsTranslation(text, target)) return null;
    const k = keyOf(text, target);
    const hit = this.cache.get(k);
    if (hit !== undefined) return hit;
    if (!this.enabled || this.inFlight.has(k) || this.queue.has(k) || (this.failedUntil.get(k) || 0) > Date.now()) return null;
    this.queue.set(k, { text, target, single: false });
    this.schedule();
    return null;
  }

  /** 查不到就返回原文 */
  tr(text, target) { return this.lookup(text, target) ?? text; }

  pending() { return this.queue.size + this.inFlight.size; }

  schedule(delay = this.delayMs) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.pump(); }, delay);
    this.timer.unref?.();
  }

  // 取一批：同一目标语言、总长不超过 BATCH_CHARS；单独太长或者之前整批失败过的单独一批
  takeBatch() {
    let target = null; let chars = 0; const items = [];
    for (const [k, it] of this.queue) {
      if (target && it.target !== target) continue;
      const alone = it.single || it.text.length > BATCH_CHARS;
      if (items.length && (alone || chars + it.text.length > BATCH_CHARS || items.length >= BATCH_ITEMS)) break;
      target = it.target; items.push([k, it]); chars += it.text.length;
      this.queue.delete(k);
      if (alone) break;
    }
    return { target, items };
  }

  pump() {
    const wait = this.pausedUntil - Date.now();
    if (wait > 0) { this.schedule(wait); return; }
    while (this.running < this.concurrency && this.queue.size) {
      const { target, items } = this.takeBatch();
      if (!items.length) break;
      this.running += 1;
      for (const [k] of items) this.inFlight.add(k);
      this.translate(target, items).finally(() => {
        this.running -= 1;
        for (const [k] of items) this.inFlight.delete(k);
        if (this.queue.size) this.schedule(50);
      });
    }
  }

  async translate(target, items) {
    let out;
    try {
      out = await this.runBatch(items.map(([, it]) => it.text), target);
      if (!Array.isArray(out) || out.length !== items.length || out.some((x) => typeof x !== 'string')) throw new Error('bad translation result');
    } catch {
      this.fails += 1;
      if (this.fails >= 3) this.pausedUntil = Date.now() + Math.min(RETRY_MS, 15_000 * 2 ** (this.fails - 3));
      // 整批失败：拆成一条一条重试（多半是某一条让模型输出坏了）；单条也失败就等一会儿再试
      if (items.length > 1) for (const [k, it] of items) this.queue.set(k, { ...it, single: true });
      else this.failedUntil.set(items[0][0], Date.now() + RETRY_MS);
      return;
    }
    this.fails = 0;
    items.forEach(([k], i) => this.cache.set(k, out[i]));
    while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value);
    this.saveSoon();
    this.onUpdate();
  }

  saveSoon() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save().catch(() => {}); }, 1000);
    this.saveTimer.unref?.();
  }

  async save() {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ v: 1, entries: Object.fromEntries(this.cache) }));
    await rename(tmp, this.file);
  }
}

/* ---------- 接口返回的数据里，哪些字段要翻 ---------- */

// 显示用的文字字段（名字、说明、结论、对话正文……）。ID、代码、日志、数字都不在里面
export const DATA_KEYS = new Set([
  'name', 'title', 'description', 'brief', 'outcome', 'what', 'detail', 'note', 'label', 'idea', 'summary', 'summary_zh', 'verdict', 'verdict_zh',
  'reasons', 'reasons_zh', 'report', 'task', 'text', 'statusZh', 'refSource', 'reason', 'error', 'mainRejected', 'rules', 'zh', 'sourceName',
  'journal', 'conclusion', 'why', 'warning', 'warnings', 'skipReason',
]);
// 这些字段下面整块跳过：工具调用的参数 / 结果（原样给 agent 看的）、代码、日志
const SKIP_KEYS = new Set(['input', 'result', 'code', 'logs', 'logTail', 'log_tail', 'stdout', 'stderr', 'diff', 'command', 'params', 'parameters', 'starters', 'prompt', 'options', 'questions']);

/**
 * 按界面语言把 data 里的显示文字换成译文（就地修改并返回）。
 * Markdown 文件（files[].name 以 .md 结尾）的 content 也翻，原文放在 contentOriginal，复制 / 下载用原文。
 */
export function translateData(translator, lang, data, depth = 0) {
  if (!translator || (lang !== 'en' && lang !== 'zh') || data == null || typeof data !== 'object' || depth > 8) return data;
  const tr = (s) => translator.tr(s, lang);
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length && i < 5000; i++) if (data[i] && typeof data[i] === 'object') translateData(translator, lang, data[i], depth + 1);
    return data;
  }
  if (typeof data.name === 'string' && /\.md$/i.test(data.name) && typeof data.content === 'string') {
    const t = tr(data.content);
    if (t !== data.content) { data.contentOriginal = data.content; data.content = t; }
  }
  for (const k of Object.keys(data)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = data[k];
    if (typeof v === 'string') { if (DATA_KEYS.has(k)) data[k] = tr(v); }
    else if (Array.isArray(v) && DATA_KEYS.has(k) && v.every((x) => typeof x === 'string')) data[k] = v.map(tr);
    else if (v && typeof v === 'object') translateData(translator, lang, v, depth + 1);
  }
  return data;
}

/** 给模型的说明：术语和界面字典保持一致 */
export function translatePrompt(target) {
  const glossary = [
    ['开发期', 'Dev period (in-sample)'], ['验证期', 'Holdout period'], ['主版本', 'Main version'], ['规则说明', 'Spec'], ['想法检验', 'Idea check'],
    ['想法记录', 'Idea log'], ['股票池', 'Universe'], ['模拟实盘', 'Paper trading'], ['候选', 'Candidate'], ['基准', 'Benchmark'], ['因子', 'Factor'],
    ['调仓', 'rebalance'], ['回撤', 'drawdown'], ['夏普', 'Sharpe'], ['年化', 'annualized'], ['去膨胀夏普', 'deflated Sharpe'], ['持有天数', 'holding days'],
    ['未标记', 'Untagged'], ['总控', 'Lead'], ['研究流水线', 'Research pipeline'], ['没有信号', 'No signal'],
  ].map(([z, e]) => (target === 'en' ? `${z} = ${e}` : `${e} = ${z}`)).join('; ');
  const to = target === 'en' ? 'English' : 'Simplified Chinese';
  return `You translate text for Helm, a quantitative trading research app. The user sends a JSON array of strings. Translate each string into ${to}.
Return ONLY a JSON array of the translated strings: same length, same order, no commentary, no code fences.
Keep exactly: numbers, dates, percentages, tickers (SPY, AAPL…), code, identifiers, file names, URLs, markdown structure (headings, tables, lists, links, code blocks), line breaks, placeholders like {name}.
A string that is already in ${to} or has nothing to translate is returned unchanged. Translate meaning naturally and concisely; do not add or drop content.
Glossary (use these terms): ${glossary}.`;
}

/** 从模型输出里取出 JSON 数组（容忍前后多余的话或代码块） */
export function parseArray(text) {
  const s = String(text || '');
  const a = s.indexOf('['); const b = s.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('no JSON array');
  return JSON.parse(s.slice(a, b + 1));
}
