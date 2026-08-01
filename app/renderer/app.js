/* 렌더러 — 엔진이 흘리는 이벤트를 화면으로만 옮긴다. 판단 로직은 두지 않는다. */
const $ = (id) => document.getElementById(id);
const stream = $('stream');
const plan = $('plan');
const input = $('input');
const sendBtn = $('send');

let busy = false;
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
      stepState(data.id, 'running', '실행 중');
      setChip(data.to, 'busy');
      break;
    case 'step:done':
      stepState(data.id, 'done', data.ms ? `${(data.ms / 1000).toFixed(1)}s` : '완료');
      setChip(data.provider, 'ok');
      msg('agent', data.provider, data.text, data.provider);
      break;
    case 'step:error':
      stepState(data.id, 'error', '실패');
      setChip(data.to, 'bad');
      msg('error', data.to, data.error);
      break;
    case 'run:done':
      msg('final', '최종', data.final);
      break;
    case 'run:error':
      msg('error', '실패', data.error);
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

/* ── 초기화 ──────────────────────────────────────────────── */
(async () => {
  const info = await window.jini.init();
  $('cwd').textContent = info.cwd;
  const box = $('providers');
  info.providers.forEach((p) => {
    const c = document.createElement('span');
    c.className = 'chip';
    c.innerHTML = `<i></i>${p.id}${p.id === info.master ? ' (마스터)' : ''}`;
    c.title = p.role;
    box.appendChild(c);
    chips.set(p.id, c);
  });
  const rows = await window.jini.doctor();
  rows.forEach((r) => {
    setChip(r.id, r.ok ? 'ok' : 'bad');
    const c = chips.get(r.id);
    if (c && r.note) c.title = `${r.role}\n${r.note}`;
  });
  const led = await window.jini.ledger();
  $('ledger').textContent = led.text;
  input.focus();
})();

$('folder').addEventListener('click', async () => {
  const r = await window.jini.pickFolder();
  $('cwd').textContent = r.cwd;
});

$('doctor').addEventListener('click', async () => {
  const rows = await window.jini.doctor();
  const text = rows
    .map((r) => `${r.ok ? '정상' : '실패'}  ${r.id}  ${r.version || '-'}${r.note ? `  · ${r.note}` : ''}`)
    .join('\n');
  rows.forEach((r) => setChip(r.id, r.ok ? 'ok' : 'bad'));
  msg('sys', '진단', text);
});
