// 手机伴侣（设计见 docs/COMPANION.md）：在手机上看自动搜索有没有找到东西、花了多少，并把想法记下来发给这台电脑。
//
// 安全边界（这是 Helm 唯一会监听局域网的地方，所以写死得很窄）：
//  - 默认关闭；用户在「设置」里打开后，才在另一个端口上起一个单独的服务。主服务仍然只监听 127.0.0.1。
//  - 这个服务只有 4 个接口：配对、看摘要、看收件箱、往收件箱里写一条想法。它碰不到 agent、回测、代码、密钥、模拟实盘。
//  - 手机发来的想法只进收件箱，不会自己开工：要用户在电脑上点一下才交给团队（否则拿到令牌的人就能远程花你的用量）。
//  - 配对：电脑上生成 6 位配对码（10 分钟有效，错 5 次作废），手机输入后换到长令牌。之后每个请求带令牌。
//
// 这个文件不起服务、不读请求（server.mjs 做）；这里是状态、配对、收件箱和摘要，都能单独测。
import crypto from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './fs-atomic.mjs';

export const DEFAULT_PORT = 4378;
export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PAIR_MAX_WRONG = 5;
export const IDEA_MAX = 2000;
export const INBOX_MAX = 200;

const safeEq = (a, b) => { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y); };

export class Companion {
  constructor({ dir, now = () => Date.now(), random = (n) => crypto.randomBytes(n) } = {}) {
    this.file = path.join(dir, 'companion.json');
    this.inboxFile = path.join(dir, 'inbox.json');
    this.dir = dir; this.now = now; this.random = random;
    this.state = null; this.pairing = null; // 配对码只在内存里：重启就作废
    this.fails = new Map(); // ip → { n, at }：令牌 / 配对码连续出错的限速
  }

  async load() {
    const s = await readJsonFile(this.file, null);
    this.state = { enabled: Boolean(s && s.enabled), port: s && Number.isInteger(s.port) && s.port > 1023 && s.port < 65536 ? s.port : DEFAULT_PORT, token: s && typeof s.token === 'string' && s.token.length >= 32 ? s.token : null, pairedAt: (s && s.pairedAt) || null };
    return this.state;
  }
  async save() {
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(this.file, this.state);
    await chmod(this.file, 0o600).catch(() => {});
  }
  async setEnabled(on) {
    if (!this.state) await this.load();
    this.state.enabled = Boolean(on);
    if (!on) this.pairing = null;
    await this.save();
    return this.state;
  }
  /** 作废令牌：已经配对的手机全部失效，要重新配对 */
  async reset() {
    if (!this.state) await this.load();
    this.state.token = null; this.state.pairedAt = null; this.pairing = null;
    await this.save();
    return this.state;
  }
  /** 电脑上生成配对码（6 位数字） */
  newPairCode() {
    const n = this.random(4).readUInt32BE(0) % 1_000_000;
    this.pairing = { code: String(n).padStart(6, '0'), expiresAt: this.now() + PAIR_TTL_MS, wrong: 0 };
    return { code: this.pairing.code, expiresAt: this.pairing.expiresAt };
  }
  /** 手机拿配对码换令牌。返回 { token } 或 { error } */
  async pair(code) {
    if (!this.state || !this.state.enabled) return { error: 'disabled' };
    const p = this.pairing;
    if (!p || this.now() > p.expiresAt) { this.pairing = null; return { error: 'no-code' }; }
    if (!safeEq(String(code || '').replace(/\D/g, ''), p.code)) {
      p.wrong += 1;
      if (p.wrong >= PAIR_MAX_WRONG) this.pairing = null;
      return { error: 'wrong-code' };
    }
    this.pairing = null; // 一个码只能用一次
    if (!this.state.token) this.state.token = this.random(32).toString('hex');
    this.state.pairedAt = this.now();
    await this.save();
    return { token: this.state.token };
  }
  authorized(header) {
    if (!this.state || !this.state.enabled || !this.state.token) return false;
    const m = /^Bearer\s+([A-Za-z0-9]+)$/.exec(String(header || ''));
    return Boolean(m && safeEq(m[1], this.state.token));
  }
  /** 限速：同一个地址 10 分钟内错 20 次就先拒绝（配对码只有 6 位，令牌虽然长也不让人一直试） */
  blocked(ip) { const f = this.fails.get(ip); return Boolean(f && f.n >= 20 && this.now() - f.at < 10 * 60 * 1000); }
  fail(ip) {
    const f = this.fails.get(ip);
    if (!f || this.now() - f.at >= 10 * 60 * 1000) this.fails.set(ip, { n: 1, at: this.now() }); else f.n += 1;
    if (this.fails.size > 500) this.fails.delete(this.fails.keys().next().value);
  }

  /* ---- 收件箱 ---- */
  async inbox() { const a = await readJsonFile(this.inboxFile, []); return Array.isArray(a) ? a : []; }
  async addIdea(text, { from = 'phone' } = {}) {
    const t = String(text || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim();
    if (t.length < 4) return { error: 'too-short' };
    if (t.length > IDEA_MAX) return { error: 'too-long' };
    const list = await this.inbox();
    if (list.filter((x) => x.status === 'new').length >= 50) return { error: 'inbox-full' };
    const idea = { id: `in${this.now().toString(36)}${this.random(3).toString('hex')}`, at: this.now(), text: t, from: String(from).slice(0, 20), status: 'new' };
    await mkdir(this.dir, { recursive: true });
    await writeJsonAtomic(this.inboxFile, [idea, ...list].slice(0, INBOX_MAX));
    return { idea };
  }
  /** 电脑上处理一条：used（交给团队了）或 dismissed（忽略） */
  async actIdea(id, status) {
    if (status !== 'used' && status !== 'dismissed') return { error: 'bad-status' };
    const list = await this.inbox();
    const it = list.find((x) => x.id === id);
    if (!it) return { error: 'not-found' };
    it.status = status; it.handledAt = this.now();
    await writeJsonAtomic(this.inboxFile, list);
    return { idea: it };
  }
}

/** 手机能连的地址：Bonjour 名（iPhone 认 .local）和局域网 IPv4 */
export function lanUrls(port, { hostname = os.hostname(), ifaces = os.networkInterfaces() } = {}) {
  const out = [];
  const h = String(hostname || '').replace(/\.local$/i, '');
  if (/^[A-Za-z0-9-]{1,63}$/.test(h)) out.push(`http://${h}.local:${port}`);
  for (const list of Object.values(ifaces || {})) for (const a of list || []) if (a && a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${port}`);
  return [...new Set(out)];
}

/* ---------------- 给手机的摘要 ---------------- */

const VERDICT = (x) => (x.holdoutPassed && x.devPassed ? 'found' : x.holdoutFailed ? 'holdout-fail' : x.devPassed ? 'dev-pass' : x.devVersions ? 'dev-fail' : x.tests ? 'no-signal' : 'pending');
const addTok = (a, b) => (b ? { in: (a ? a.in : 0) + (b.in || 0), out: (a ? a.out : 0) + (b.out || 0), cache: (a ? a.cache : 0) + (b.cache || 0) } : a);

/**
 * runs：Autopilot.runView 的列表（新的在前）。把同一次连续搜索的各轮合在一起，只回答三件事：
 * 现在在不在跑、找没找到、花了多少。projectName(id) 给候选起名字。
 */
export function searchSummary(runs = [], { projectName = () => '', now = Date.now() } = {}) {
  const latest = runs[0];
  if (!latest) return null;
  const chainId = latest.chain ? (latest.chain.id || latest.runId) : null;
  const rounds = chainId ? runs.filter((r) => r.runId === chainId || (r.chain && r.chain.id === chainId)) : [latest];
  const sum = (f) => rounds.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  const found = rounds.flatMap((r) => (r.found || []).map((f) => ({ projectId: f.projectId, name: projectName(f.projectId) || `#${f.projectId}`, backtestId: f.backtestId })));
  const live = rounds.find((r) => r.status === 'running') || null;
  const state = live ? 'running' : found.length ? 'found' : latest.status === 'error' ? 'error' : latest.status === 'stopped' || latest.status === 'interrupted' ? 'stopped'
    : latest.untilFound && !latest.chainEnd && !latest.nextRunId && latest.status === 'done' ? 'running' /* 两轮之间的一两秒 */ : 'nothing';
  const L = latest.ledger || {};
  const tokens = rounds.reduce((a, r) => addTok(a, r.tokens), null);
  const first = rounds[rounds.length - 1];
  return {
    state, continuous: Boolean(latest.untilFound), round: latest.chain ? latest.chain.round : 1, rounds: rounds.length,
    startedAt: (latest.chain && latest.chain.startedAt) || first.createdAt, endedAt: live ? null : latest.endedAt, minutes: Math.max(0, Math.round(((live ? now : latest.endedAt || now) - ((latest.chain && latest.chain.startedAt) || first.createdAt)) / 60000)),
    found, reason: live ? null : latest.chainEnd || latest.reason || null,
    ideas: sum((r) => (r.ledger || {}).ideas), ideaTests: sum((r) => (r.ledger || {}).tests), devVersions: sum((r) => (r.ledger || {}).devVersions), holdoutLooks: sum((r) => (r.ledger || {}).holdoutLooks),
    costUsd: Math.round(sum((r) => r.cost) * 100) / 100, capUsd: latest.chain ? latest.chain.usdTotal : (latest.caps || {}).usd || null, tokens,
    // 这一轮的想法清单（标题截短）和各自的结论
    current: (latest.plan || []).map((it, i) => { const x = (L.per || []).find((y) => y.planIdea === i + 1); return { title: String(it.title || '').slice(0, 120), kind: it.kind || null, verdict: x ? VERDICT(x) : 'pending' }; }),
    directions: (latest.batches || []).map((b) => String(b.name || '').slice(0, 60)),
  };
}

/** 整个摘要：搜索 + 模拟实盘 + 收件箱里还没处理的条数。全部是只读的数字和名字，不含代码、密钥、对话内容 */
export function buildSummary({ runs = [], projectName, paper = [], inbox = [], host = os.hostname(), now = Date.now() } = {}) {
  return {
    at: now, host: String(host || '').replace(/\.local$/i, '').slice(0, 60),
    search: searchSummary(runs, { projectName, now }),
    paper: paper.slice(0, 20).map((s) => ({ name: String(s.name || '').slice(0, 60), project: String(s.project || '').slice(0, 80), mode: s.mode === 'alpaca' ? 'alpaca' : 'sim', days: Number(s.days) || 0, ret: s.ret ?? null, bench: s.bench ?? null, ok: s.ok !== false, dataDate: s.dataDate || null })),
    inbox: { new: inbox.filter((x) => x.status === 'new').length, total: inbox.length },
  };
}
