import http from 'node:http';

/* 本机 POST 到 Helm 服务，用 node:http 而不是 fetch：
   Node 自带的 fetch（undici）默认 5 分钟收不到响应头就断开（headersTimeout）。handoff(wait=true) 要等对方做完、ask_user 要等用户回答，
   常常超过 5 分钟：fetch 在第 5 分钟报「fetch failed」，服务端看到请求断开，会把正在干活的子对话一起停掉（真实发生过：想法检验跑到一半被停，
   总控又交接了两次）。这里只有我们自己给的 timeoutMs。返回 { ok, status, json() }，超时抛 name=TimeoutError 的错误。 */
export function postLocal(url, body, { headers = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) });
      });
      res.on('error', reject);
    });
    const timer = setTimeout(() => { req.destroy(Object.assign(new Error(`等待超过 ${Math.round(timeoutMs / 1000)} 秒`), { name: 'TimeoutError' })); }, timeoutMs);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    req.end(data);
  });
}

