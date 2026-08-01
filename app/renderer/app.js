/* 렌더러 — 엔진이 흘리는 이벤트를 화면으로만 옮긴다. 판단 로직은 두지 않는다. */
const $ = (id) => document.getElementById(id);
const stream = $('stream');
const plan = $('plan');
const input = $('input');
const sendBtn = $('send');

let busy = false;
let logPath = '';
const chips = new Map();

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function clearWelcome() {
  const w = stream.querySelector('.welcome');
  if (w) w.remove();
}

function msg(kind, who, text, cls = '') {
  clearWelcome();
  const el = document.createElement('div');
  el.className = `msg ${kind} ${cls}`;
  el.innerHTML = `<div class="who">${esc(who)}</div><div class="body">${esc(text)}</div>`;
  stream.appendChild(el);
  stream.scrollTop = stream.scrollHeight;
  return el;
}

function setChip(id, state) {
  const c = chips.get(id);
  if (c) c.className = `chip ${state}`;
}

/* ── 파이프라인 패널 ─────────────────────────────────────── */
function renderPlan(steps, batches) {
  plan.innerHTML = '';
  batches.forEach((ids, i) => {
    const box = document.createElement('div');
    box.className = `batch${ids.length > 1 ? ' parallel' : ''}`;
    box.innerHTML = `<div class="batch-label">${i + 1}단계 · ${ids.length}개</div>`;
    ids.forEach((id) => {
      const s = steps.find((x) => x.id === id);
      const el = document.createElement('div');
      el.className = `step ${s.to}`;
      el.id = `step-${id}`;
      el.title = s.prompt;
      el.innerHTML =
        `<div class="step-top"><span class="step-agent">${esc(s.to)}</span>` +
        `<span class="step-state">대기</span></div>` +
        `<div class="step-prompt">${esc(s.prompt)}</div>`;
      box.appendChild(el);
    });
    plan.appendChild(box);
  });
}

function stepState(id, state, label) {
  const el = document.getElementById(`step-${id}`);
  if (!el) return;
  el.classList.remove('running', 'done', 'error');
  el.classList.add(state);
  const s = el.querySelector('.step-state');
  if (s) s.textContent = label;
}

/* 진행 중 경과 시간 — 긴 단계에서 화면이 멈춘 것처럼 보이지 않게 한다. */
const running = new Map(); // id -> 시작 시각
let ticker = null;

function tick() {
  const now = Date.now();
  for (const [id, t0] of running) {
    const el = document.getElementById(`step-${id}`);
    const s = el?.querySelector('.step-state');
    if (s) s.textContent = `${Math.round((now - t0) / 1000)}s…`;
  }
  const el = $('elapsed');
  if (el) {
    el.textContent = running.size
      ? `실행 중 ${running.size}개 · ${Math.round((now - Math.min(...running.values())) / 1000)}s`
      : '';
  }
}

function startTick(id) {
  running.set(id, Date.now());
  if (!ticker) ticker = setInterval(tick, 1000);
  tick();
}

function stopTick(id) {
  running.delete(id);
  if (!running.size && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
  tick();
}

/* ── 이벤트 구독 ─────────────────────────────────────────── */
window.jini.onEvent(({ type, data }) => {
  switch (type) {
    case 'plan:start':
      plan.innerHTML = '<p class="hint">마스터가 작업을 분해하는 중…</p>';
      setChip(data.master, 'busy');
      break;
    case 'plan:done': {
      setChip('claude', 'ok');
      const batches = data.batches;
      renderPlan(data.steps, batches);
      const par = batches.filter((b) => b.length > 1).length;
      msg('sys', '계획', `${data.steps.length}단계 · ${batches.length}배치${par ? ` (병렬 배치 ${par}개)` : ''}`);
      break;
    }
    case 'step:start':
      stepState(data.id, 'running', '0s…');
      startTick(data.id);
      setChip(data.to, 'busy');
      break;
    case 'step:done':
      stopTick(data.id);
      stepState(data.id, 'done', data.ms ? `${(data.ms / 1000).toFixed(1)}s` : '완료');
      setChip(data.provider, 'ok');
      msg('agent', data.provider, data.text, data.provider);
      break;
    case 'step:error':
      stopTick(data.id);
      stepState(data.id, 'error', '실패');
      setChip(data.to, 'bad');
      msg('error', data.to, data.error);
      break;
    case 'run:done':
      msg('final', '최종', data.final);
      break;
    case 'run:error':
      msg('error', '실패', `${data.error}\n\n로그: ${logPath || '(경로 미확인)'}`);
      break;
    case 'ledger':
      $('ledger').textContent = data.text;
      break;
  }
});

/* ── 전송 ────────────────────────────────────────────────── */
async function submit() {
  const text = input.value.trim();
  if (!text || busy) return;
  busy = true;
  sendBtn.disabled = true;
  input.value = '';
  msg('user', '나', text);

  // @provider 접두는 파이프라인을 건너뛰고 해당 AI 에 직접 묻는다
  const direct = text.match(/^@(\w+)\s+([\s\S]+)$/);
  try {
    if (direct) {
      plan.innerHTML = `<p class="hint">${esc(direct[1])} 에 직접 질의 중…</p>`;
      const r = await window.jini.ask(direct[1], direct[2]);
      if (!r.ok) msg('error', '실패', r.error);
    } else {
      const r = await window.jini.run(text);
      if (!r.ok) msg('error', '실패', r.error);
    }
  } finally {
    busy = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  submit();
});
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

/* ── 작업 폴더 ───────────────────────────────────────────── */
function renderFolder(r) {
  $('cwd').textContent = r.cwd;
  $('cwdPath').textContent = r.cwd;
  const box = $('files');
  box.innerHTML = '';
  if (r.error) {
    box.innerHTML = `<div>읽을 수 없음: ${esc(r.error)}</div>`;
    return;
  }
  r.entries.forEach((e) => {
    const el = document.createElement('div');
    el.className = e.dir ? 'd' : '';
    el.textContent = e.dir ? `${e.name}/` : e.name;
    box.appendChild(el);
  });
  if (r.total > r.entries.length) {
    const m = document.createElement('div');
    m.className = 'more';
    m.textContent = `… 외 ${r.total - r.entries.length}개`;
    box.appendChild(m);
  }
}

async function refreshFolder() {
  renderFolder(await window.jini.listDir());
}

$('pick').addEventListener('click', async () => {
  const r = await window.jini.pickFolder();
  renderFolder(r);
  msg('sys', '작업 폴더', `${r.cwd}\n이후 작업은 이 폴더를 기준으로 실행됩니다.`);
});
$('folder').addEventListener('click', () => $('pick').click());

/* ── 계정 ────────────────────────────────────────────────── */
function renderAccounts(rows) {
  const box = $('accounts');
  box.innerHTML = '';
  rows.forEach((r) => {
    const state = !r.installed || !r.auth.ok ? 'bad' : r.auth.method === 'api-key' ? 'keyed' : 'ok';
    const el = document.createElement('div');
    el.className = `acct ${state}`;
    const how = !r.installed ? '미설치' : r.auth.detail;
    el.innerHTML = `<i></i><span class="name">${esc(r.id)}</span><span class="how">${esc(how)}</span>`;
    // 미설치면 [설치], 설치됐는데 로그인이 없거나 키 방식이면 [로그인]
    const action = !r.installed
      ? { label: '설치', run: () => window.jini.install(r.id) }
      : state !== 'ok'
        ? { label: '로그인', run: () => window.jini.login(r.id) }
        : null;
    if (action) {
      const b = document.createElement('button');
      b.textContent = action.label;
      b.onclick = async () => {
        const res = await action.run();
        msg(
          'sys',
          `${r.id} ${action.label}`,
          res.ok ? `터미널을 열었습니다: ${res.command}\n${res.guide}` : `실패: ${res.error}`
        );
      };
      el.appendChild(b);
    }
    box.appendChild(el);
    setChip(r.id, state === 'ok' ? 'ok' : state === 'keyed' ? 'busy' : 'bad');
    const c = chips.get(r.id);
    if (c) c.title = `${r.role}\n${how}`;
  });
}

async function refreshDoctor() {
  const rows = await window.jini.doctor();
  renderAccounts(rows);
  return rows;
}

$('doctor').addEventListener('click', async () => {
  const rows = await refreshDoctor();
  msg(
    'sys',
    '진단',
    rows
      .map((r) => `${r.ok ? '정상' : '조치필요'}  ${r.id}  ${r.version || '-'}  · ${r.installed ? r.auth.detail : '미설치'}`)
      .join('\n')
  );
});

/* ── 설정 ────────────────────────────────────────────────── */
const GROUP_LABEL = { cli: '계정 로그인 백엔드', both: '공통', api: 'API 백엔드 전용' };

function renderSettings(res) {
  const body = $('settingsBody');
  body.innerHTML = '';
  if (res.error) {
    const e = document.createElement('div');
    e.className = 'set-err';
    e.textContent = res.error;
    body.appendChild(e);
  }
  for (const scope of ['cli', 'both', 'api']) {
    const rows = res.rows.filter((r) => r.scope === scope);
    if (!rows.length) continue;
    const h = document.createElement('div');
    h.className = 'set-group';
    h.textContent = GROUP_LABEL[scope];
    body.appendChild(h);

    rows.forEach((r) => {
      const row = document.createElement('div');
      row.className = `set-row${r.isDefault ? '' : ' custom'}`;

      const k = document.createElement('div');
      k.className = 'k';
      k.innerHTML = `${esc(r.key)}<small>${esc(r.label)}</small>`;
      row.appendChild(k);

      let field;
      if (r.type === 'choice' || r.type === 'bool') {
        field = document.createElement('select');
        const opts = r.type === 'bool' ? ['true', 'false'] : r.choices;
        opts.forEach((o) => {
          const op = document.createElement('option');
          op.value = o;
          op.textContent = o;
          if (String(r.value) === o) op.selected = true;
          field.appendChild(op);
        });
      } else {
        field = document.createElement('input');
        field.type = r.type === 'int' ? 'number' : 'text';
        field.value = r.value === null || r.value === undefined ? '' : String(r.value);
      }
      field.onchange = async () => {
        const out = await window.jini.settings('set', r.key, field.value);
        renderSettings(out);
        if (out.ok) msg('sys', '설정', `${r.key} = ${field.value}`);
      };
      row.appendChild(field);

      const rst = document.createElement('button');
      rst.className = 'reset';
      rst.textContent = r.isDefault ? '기본값' : '되돌리기';
      rst.disabled = r.isDefault;
      rst.onclick = async () => renderSettings(await window.jini.settings('reset', r.key));
      row.appendChild(rst);

      body.appendChild(row);
    });
  }
  $('settingsPath').textContent = `저장 위치: ${res.path}`;
}

$('settings').addEventListener('click', async () => {
  renderSettings(await window.jini.settings('list'));
  $('modal').classList.remove('hidden');
});
$('modalClose').addEventListener('click', () => $('modal').classList.add('hidden'));
$('modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal') $('modal').classList.add('hidden');
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $('modal').classList.add('hidden');
});

/* ── 초기화 ──────────────────────────────────────────────── */
(async () => {
  const info = await window.jini.init();
  logPath = info.logPath || '';
  const box = $('providers');
  info.providers.forEach((p) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `<i></i>${p.id}${p.id === info.master ? ' (마스터)' : ''}`;
    c.title = p.role;
    box.appendChild(c);
    chips.set(p.id, c);
  });
  await refreshFolder();
  if (info.isHome) {
    msg(
      'sys',
      '작업 폴더 확인',
      '지금 작업 폴더가 홈 디렉터리입니다. 홈 전체를 대상으로 하면 느리고 실패하기 쉽습니다 —\n' +
        '좌측 [폴더 열기]로 실제 작업할 프로젝트 폴더를 먼저 선택하세요.'
    );
  }
  const rows = await refreshDoctor();
  const missing = rows.filter((r) => !r.installed);
  const need = rows.filter((r) => r.installed && !r.auth.ok);
  if (missing.length) {
    msg('sys', '설치 필요', `${missing.map((r) => r.id).join(', ')} — 좌측 [계정]에서 [설치]를 누르세요.`);
  }
  if (need.length) {
    msg(
      'sys',
      '로그인 필요',
      `${need.map((r) => r.id).join(', ')} — 좌측 [계정]에서 [로그인]을 누르세요. 각자 본인 계정으로 로그인합니다.`
    );
  }
  $('ledger').textContent = (await window.jini.ledger()).text;
  input.focus();
})();
