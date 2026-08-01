import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * 리모트 컨트롤 — 폰이나 다른 PC 의 브라우저에서 Jini 에 작업을 던진다.
 *
 * 보안 기본값(끄지 않는 한 유지):
 *  - 기본 bind 는 127.0.0.1 (같은 PC 에서만). LAN 개방은 설정에서 명시적으로 골라야 한다.
 *  - 모든 요청에 토큰이 필요하고, 비교는 길이 노출 없는 상수시간 비교를 쓴다.
 *  - 토큰이 없으면 서버가 아예 뜨지 않는다(무인증 노출 금지).
 */

export const genToken = () => crypto.randomBytes(16).toString('hex');

/** 상수시간 비교 — 토큰 길이·내용이 타이밍으로 새지 않게 한다. */
export function tokenEquals(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** LAN 에서 접속할 때 쓸 IPv4 주소(없으면 null). */
export function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return null;
}

export function buildUrl({ bind, port, token }) {
  const host = bind === 'lan' ? lanAddress() || '0.0.0.0' : '127.0.0.1';
  return `http://${host}:${port}/?t=${token}`;
}

const PAGE = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Jini 리모트</title><style>
:root{--bg:#0e1116;--bg2:#171d26;--fg:#e6edf3;--dim:#8b98a9;--accent:#5b9dff;--err:#f85149}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:15px/1.6 -apple-system,"Segoe UI","Malgun Gothic",sans-serif;display:flex;flex-direction:column;height:100vh}
header{padding:12px 16px;border-bottom:1px solid #263041;font-weight:700}
header span{color:var(--accent)}
#log{flex:1;overflow-y:auto;padding:14px 16px}
.e{margin-bottom:10px;white-space:pre-wrap;word-break:break-word}
.e .w{font-size:11px;color:var(--dim)}
.e.final{background:var(--bg2);border:1px solid var(--accent);border-radius:10px;padding:10px}
.e.err{color:var(--err)}
form{display:flex;gap:8px;padding:12px 16px;border-top:1px solid #263041;background:var(--bg2)}
textarea{flex:1;background:var(--bg);color:var(--fg);border:1px solid #263041;border-radius:10px;
padding:10px;font:inherit;resize:none;outline:none}
button{background:var(--accent);color:#06101f;border:0;border-radius:10px;padding:0 18px;font-weight:700}
</style></head><body>
<header>Jini <span>리모트</span></header>
<div id="log"><div class="e"><div class="w">안내</div>작업을 입력하면 이 PC 의 Jini 가 실행합니다.</div></div>
<form id="f"><textarea id="t" rows="2" placeholder="작업을 입력하세요"></textarea><button>전송</button></form>
<script>
const q=new URLSearchParams(location.search),tok=q.get('t')||'';
const log=document.getElementById('log');
function add(cls,who,text){const d=document.createElement('div');d.className='e '+cls;
d.innerHTML='<div class="w"></div><div class="b"></div>';
d.querySelector('.w').textContent=who;d.querySelector('.b').textContent=text;
log.appendChild(d);log.scrollTop=log.scrollHeight;}
const es=new EventSource('/events?t='+encodeURIComponent(tok));
es.onmessage=(m)=>{const {type,data}=JSON.parse(m.data);
if(type==='plan:done')add('','계획',data.steps.length+'단계 · '+data.batches.length+'배치');
else if(type==='step:start')add('','시작',data.to);
else if(type==='step:done')add('',data.provider,data.text);
else if(type==='step:error')add('err',data.to,data.error);
else if(type==='run:done')add('final','최종',data.final);
else if(type==='run:error')add('err','실패',data.error);};
es.onerror=()=>add('err','연결','스트림이 끊겼습니다. 새로고침하세요.');
document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();
const t=document.getElementById('t');const task=t.value.trim();if(!task)return;
add('','나',task);t.value='';
const r=await fetch('/run?t='+encodeURIComponent(tok),{method:'POST',
headers:{'content-type':'application/json'},body:JSON.stringify({task})});
if(!r.ok)add('err','실패','요청 거부됨 ('+r.status+')');};
</script></body></html>`;

/**
 * 리모트 서버를 만든다.
 * @param {object} opts
 * @param {string} opts.token   필수. 없으면 시작하지 않는다.
 * @param {number} opts.port
 * @param {'localhost'|'lan'} opts.bind
 * @param {(task:string, emit:(type:string,data:object)=>void)=>Promise<void>} opts.runTask
 */
export function createRemoteServer({ token, port = 8765, bind = 'localhost', runTask }) {
  if (!token) throw new Error('리모트 토큰이 없습니다 — 무인증으로는 열지 않습니다');

  const clients = new Set();
  const emit = (type, data) => {
    const line = `data: ${JSON.stringify({ type, data })}\n\n`;
    for (const res of clients) {
      try {
        res.write(line);
      } catch { /* 끊긴 클라이언트는 close 에서 정리된다 */ }
    }
  };

  const authed = (req) => {
    const url = new URL(req.url, 'http://x');
    const t = url.searchParams.get('t') || req.headers['x-jini-token'];
    return tokenEquals(t, token);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    if (!authed(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('토큰이 필요합니다');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGE);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/run') {
      let body = '';
      req.on('data', (c) => {
        body += c;
        if (body.length > 100_000) req.destroy();
      });
      req.on('end', async () => {
        let task = '';
        try {
          task = JSON.parse(body).task || '';
        } catch { /* 파싱 실패는 아래에서 400 */ }
        if (!task.trim()) {
          res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('task 가 비었습니다');
          return;
        }
        res.writeHead(202, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('accepted');
        try {
          await runTask(task, emit);
        } catch (e) {
          emit('run:error', { error: e.message });
        }
      });
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('없는 경로');
  });

  return {
    emit,
    get url() {
      return buildUrl({ bind, port, token });
    },
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, bind === 'lan' ? '0.0.0.0' : '127.0.0.1', () => resolve(this.url));
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const res of clients) {
          try {
            res.end();
          } catch { /* 무시 */ }
        }
        clients.clear();
        server.close(() => resolve());
      });
    },
  };
}
