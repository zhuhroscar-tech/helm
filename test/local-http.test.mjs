// 本机长请求：node test/local-http.test.mjs
// MCP 调 Helm 服务（handoff wait=true、ask_user、审批）可能要等十几分钟。Node 自带的 fetch 5 分钟收不到响应头就断开
// （undici headersTimeout，2026-11-24 一轮真实的自动研究里交接因此失败两次），所以这些请求改用 lib/local-http.mjs 的 postLocal。
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { postLocal } from '../lib/local-http.mjs';

let failed = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); if (!cond) failed += 1; };

const srv = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const delay = req.url === '/slow' ? 1500 : 0;
    setTimeout(() => { res.writeHead(req.url === '/bad' ? 400 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ got: JSON.parse(body || '{}'), token: req.headers['x-helm-token'] || null })); }, delay);
  });
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.on('listening', r));
const base = `http://127.0.0.1:${srv.address().port}`;

const r1 = await postLocal(`${base}/ok`, { a: 1 }, { headers: { 'x-helm-token': 't' } });
const j1 = await r1.json();
check('正常请求：带上请求体和请求头，返回 ok / status / json()', r1.ok && r1.status === 200 && j1.got.a === 1 && j1.token === 't');
const r2 = await postLocal(`${base}/bad`, {});
check('出错的状态码：ok=false', !r2.ok && r2.status === 400);
const r3 = await postLocal(`${base}/slow`, {}, { timeoutMs: 5000 });
check('慢响应在超时之内：正常返回', r3.ok);
let err = null;
try { await postLocal(`${base}/slow`, {}, { timeoutMs: 300 }); } catch (e) { err = e; }
check('超过我们给的超时：抛 TimeoutError（handoff 据此提示「不要再交接一次」）', err && err.name === 'TimeoutError', err && err.message);
let err2 = null;
try { await postLocal('http://127.0.0.1:1/x', {}); } catch (e) { err2 = e; }
check('连不上：抛错', Boolean(err2));
srv.close();

const mcp = readFileSync(new URL('../mcp/qc-mcp.mjs', import.meta.url), 'utf8');
check('MCP 调 Helm 服务不再用 fetch（5 分钟会被断开）', !/fetch\(\s*`\$\{url\}/.test(mcp) && /postLocal\(`\$\{url\}\/api\/handoff`/.test(mcp));

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
