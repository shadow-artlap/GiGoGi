'use strict';
/* GiGoGi UI — ทำงานคู่กับ gigogi/api.py ผ่าน window.pywebview.api */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (n, cls = '') => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const store = {
  get(k, d) { try { const v = localStorage.getItem('gg.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('gg.' + k, JSON.stringify(v)); } catch { /* ไม่มีที่เก็บก็ใช้ค่าเริ่มต้น */ } },
};

const S = {
  inited: false, page: 'home', ready: false, dstate: null, devices: [], current: null,
  tools: { adb: true, scrcpy: true }, settings: {}, version: '', repo: '', logs: [],
  mirror: false, rec: { active: false, started: 0 }, info: null, infoAt: 0, frame: null,
  rate: store.get('rate', 1500),
  files: { path: '/sdcard', items: [], view: [], sel: new Set(), filter: '', sort: 'name', asc: true, anchor: null, loaded: false },
  apps: { kind: 'user', list: [], filter: '', sel: null, loaded: false, token: 0 },
  history: [], hi: 0,
};
let api = null;
const pending = [];

/* ================================================================ helpers */
function errText(e) {
  if (!e) return 'เกิดข้อผิดพลาด';
  if (typeof e === 'string') return e;
  return e.message || String(e);
}
async function call(name, ...args) {
  try { return await api[name](...args); } catch (e) { toast(errText(e), 'error'); throw e; }
}
async function quiet(name, ...args) {
  try { return await api[name](...args); } catch { return null; }
}
function fmtBytes(n) {
  if (n == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < 4) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(n < 10 ? 1 : n < 100 ? 1 : 0)) + ' ' + u[i];
}
function fmtUptime(s) {
  if (s == null) return '—';
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d} วัน ${h} ชั่วโมง` : h ? `${h} ชั่วโมง ${m} นาที` : `${m} นาที`;
}
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
function fmtDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}:\d{2}))?/.exec(s || '');
  if (!m) return s || '—';
  const now = new Date();
  const same = +m[1] === now.getFullYear() && +m[2] === now.getMonth() + 1 && +m[3] === now.getDate();
  if (same && m[4]) return `วันนี้ ${m[4]}`;
  const yr = +m[1] === now.getFullYear() ? '' : ` ${(+m[1] + 543) % 100}`;
  return `${+m[3]} ${TH_MONTHS[+m[2] - 1]}${yr}${m[4] ? ' ' + m[4] : ''}`;
}
const join = (a, b) => (a.replace(/\/+$/, '') + '/' + b).replace(/\/+/g, '/');
const parent = p => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/';

/* ================================================================ toasts & modals */
const toastMap = new Map();
function toast(msg, kind = 'info', opt = {}) {
  let el = opt.id ? toastMap.get(opt.id) : null;
  if (!el) {
    el = document.createElement('div');
    $('#toasts').append(el);
    if (opt.id) toastMap.set(opt.id, el);
    const all = $$('.toast');
    if (all.length > 4) all[0].remove();
  }
  el.className = `toast ${kind}`;
  el.innerHTML = `<span class="t-msg">${esc(msg)}</span>`
    + (opt.action ? `<button class="t-act">${esc(opt.action.label)}</button>` : '<span></span>')
    + (opt.progress != null ? `<div class="t-prog ${opt.progress < 0 ? 'indet' : ''}"><i style="width:${clamp(opt.progress, 0, 1) * 100}%"></i></div>` : '');
  if (opt.action) el.querySelector('.t-act').onclick = () => { opt.action.fn(); dropToast(el, opt.id); };
  clearTimeout(el._t);
  if (!opt.sticky) el._t = setTimeout(() => dropToast(el, opt.id), opt.ms || (kind === 'error' ? 8000 : opt.action ? 7000 : 4200));
  return el;
}
function dropToast(el, id) { el.remove(); if (id) toastMap.delete(id); }

function modal(html, wide = false) {
  const bd = $('#modal'), m = bd.firstElementChild;
  m.className = 'modal' + (wide ? ' wide' : '');
  m.innerHTML = html;
  bd.hidden = false;
  return m;
}
function closeModal() { $('#modal').hidden = true; $('#modal').firstElementChild.innerHTML = ''; $('#modal')._close = null; }
function dialog(build, focusSel) {
  return new Promise(resolve => {
    const m = build();
    const done = v => { document.removeEventListener('keydown', key, true); closeModal(); resolve(v); };
    const key = e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    $('#modal')._close = () => done(null);
    document.addEventListener('keydown', key, true);
    m._done = done;
    (m.querySelector(focusSel) || m.querySelector('button'))?.focus();
  });
}
function confirmBox({ title, body = '', items = null, ok = 'ยืนยัน', danger = false }) {
  return dialog(() => {
    const m = modal(`<h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}`
      + (items ? `<ul>${items.slice(0, 12).map(i => `<li>${esc(i)}</li>`).join('')}${items.length > 12 ? `<li>และอีก ${items.length - 12} รายการ</li>` : ''}</ul>` : '')
      + `<div class="modal-actions"><button class="btn ghost" data-r="0">ยกเลิก</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>`);
    m.querySelectorAll('[data-r]').forEach(b => { b.onclick = () => m._done(b.dataset.r === '1'); });
    return m;
  }, danger ? '[data-r="0"]' : '[data-r="1"]').then(v => !!v);
}
function promptBox({ title, body = '', value = '', ok = 'บันทึก', placeholder = '' }) {
  return dialog(() => {
    const m = modal(`<h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">`
      + `<div class="modal-actions"><button class="btn ghost" data-r="0">ยกเลิก</button><button class="btn primary" data-r="1">${esc(ok)}</button></div>`);
    const inp = m.querySelector('input');
    const submit = () => { const v = inp.value.trim(); if (v) m._done(v); };
    m.querySelector('[data-r="0"]').onclick = () => m._done(null);
    m.querySelector('[data-r="1"]').onclick = submit;
    inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
    setTimeout(() => { inp.focus(); const dot = value.lastIndexOf('.'); inp.setSelectionRange(0, dot > 0 ? dot : value.length); }, 0);
    return m;
  }, 'input');
}

/* ================================================================ navigation */
const TITLES = { home: 'หน้าหลัก', screen: 'หน้าจอ', files: 'ไฟล์', apps: 'แอพ', tools: 'เครื่องมือ', settings: 'ตั้งค่า' };
function go(page) {
  S.page = page;
  document.body.dataset.page = page;
  $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => { p.hidden = p.id !== 'page-' + page; });
  $('#page-title').textContent = TITLES[page];
  closeMenus();
  onPageShown();
}
function onPageShown() {
  loop.restart();
  if (!S.ready) return;
  if (S.page === 'home' && (!S.info || Date.now() - S.infoAt > 15000)) loadInfo();
  if (S.page === 'files' && !S.files.loaded) listFiles(S.files.path);
  if (S.page === 'apps' && !S.apps.loaded) loadApps();
  if (S.page === 'screen') $('#viewer').focus({ preventScroll: true });
}

/* ================================================================ devices */
function deviceSub(d) {
  if (!d) return S.tools.adb ? 'เสียบมือถือด้วยสาย USB' : 'ไม่พบเครื่องมือเชื่อมต่อ';
  if (d.state === 'device') return d.transport === 'wifi' ? 'เชื่อมต่อผ่าน Wi‑Fi' : 'เชื่อมต่อผ่าน USB';
  if (d.state === 'unauthorized') return 'รอกด "อนุญาต" บนมือถือ';
  if (d.state === 'offline') return 'ขาดการเชื่อมต่อ';
  return d.state;
}
function applyDevices(d) {
  const was = S.ready, prev = S.current;
  S.devices = d.devices || []; S.current = d.current; S.ready = !!d.ready; S.dstate = d.state;
  document.body.classList.toggle('ready', S.ready);
  renderSwitch(); renderConnect(); renderWifiList();
  $('#mirror-btn').disabled = !S.ready;
  const fresh = S.ready && (!was || prev !== S.current);
  if (fresh) {
    S.info = null; S.frame = null;
    Object.assign(S.files, { path: '/sdcard', items: [], view: [], loaded: false, filter: '' }); S.files.sel.clear();
    Object.assign(S.apps, { list: [], loaded: false, sel: null });
    $('#home-shot').removeAttribute('src'); $('#live').removeAttribute('src');
    $('#dev-name').textContent = S.devices.find(x => x.serial === S.current)?.model || 'มือถือ';
    $('#dev-sub').textContent = ''; $('#facts').innerHTML = '';
    renderAppDetail(null);
    $$('.phone').forEach(p => p.classList.remove('lit'));
    requestAnimationFrame(() => requestAnimationFrame(() => $$('.phone').forEach(p => p.classList.add('lit'))));
  }
  if (was && !S.ready) {
    toast(S.dstate ? deviceSub({ state: S.dstate }) : 'มือถือหลุดการเชื่อมต่อแล้ว', 'warn');
    $$('.phone').forEach(p => p.classList.remove('lit'));
    if (S.rec.active) setRec(false);
  }
  $('#stage').hidden = !S.ready;
  $('#connect').hidden = S.ready;
  if (fresh || (was && !S.ready)) onPageShown();
}
function renderSwitch() {
  const d = S.devices.find(x => x.serial === S.current);
  const dot = $('#status-dot');
  dot.className = 'status-dot ' + (!d ? '' : d.state === 'device' ? 'ok' : d.state === 'unauthorized' ? 'wait' : 'bad');
  $('#ds-name').textContent = d ? (d.model || 'มือถือ Android') : 'ยังไม่ได้เชื่อมต่อ';
  $('#ds-sub').textContent = deviceSub(d) + (S.devices.length > 1 ? ` (มี ${S.devices.length} เครื่อง)` : '');
}
function renderDeviceMenu() {
  const menu = $('#device-menu');
  const rows = S.devices.map(d => `<button data-serial="${esc(d.serial)}">${icon(d.transport === 'wifi' ? 'wifi' : 'usb')}
      <span><span>${esc(d.model || d.serial)}</span><small>${esc(deviceSub(d))}</small></span>
      ${d.serial === S.current ? `<span class="check">${icon('check', 'sm')}</span>` : ''}</button>`).join('');
  menu.innerHTML = (rows || '<button disabled><span><span>ยังไม่พบมือถือ</span><small>เสียบสาย USB แล้วรอสักครู่</small></span></button>')
    + `<div class="menu-sep"></div>
       <button data-menu="wifi">${icon('wifi')}<span>เชื่อมต่อผ่าน Wi‑Fi</span></button>
       <button data-menu="guide">${icon('usb')}<span>วิธีเชื่อมต่อมือถือ</span></button>`;
}
function closeMenus() { $$('.menu').forEach(m => { m.hidden = true; }); }

const STEPS = [
  ['เปิดโหมดนักพัฒนา', 'ตั้งค่า › เกี่ยวกับโทรศัพท์ › แตะ "หมายเลขบิลด์" 7 ครั้ง'],
  ['เปิดการแก้ไขข้อบกพร่อง USB', 'ตั้งค่า › ระบบ › ตัวเลือกสำหรับนักพัฒนา › เปิด "USB debugging"'],
  ['เสียบสาย USB', 'ใช้สายที่ส่งข้อมูลได้ ถ้ามือถือถามโหมด USB ให้เลือก "ถ่ายโอนไฟล์"'],
  ['กดอนุญาตบนมือถือ', 'ติ๊ก "อนุญาตจากคอมพิวเตอร์เครื่องนี้เสมอ" แล้วกด "อนุญาต"'],
];
function connectHTML() {
  let title = 'เสียบมือถือเพื่อเริ่มใช้งาน';
  let lead = 'ทำ 4 ขั้นตอนนี้ครั้งแรกครั้งเดียว ครั้งต่อไปแค่เสียบสายก็ใช้ได้ทันที';
  let cls = '', now = 0;
  if (!S.tools.adb) { lead = 'ไม่พบเครื่องมือเชื่อมต่อ (adb) ติดตั้งโปรแกรมใหม่ด้วยตัวติดตั้ง'; cls = 'wait'; }
  else if (S.dstate === 'unauthorized') { title = 'เจอมือถือแล้ว'; lead = 'กด "อนุญาต" บนหน้าจอมือถือเพื่อเชื่อมต่อ'; cls = 'wait'; now = 4; }
  else if (S.dstate === 'offline') { title = 'มือถือขาดการเชื่อมต่อ'; lead = 'ถอดสายแล้วเสียบใหม่ หรือเปลี่ยนพอร์ต USB'; cls = 'wait'; now = 3; }
  const steps = STEPS.map(([t, d], i) => `<li class="${i + 1 < now ? 'done' : i + 1 === now ? 'now' : ''}"><div><b>${t}</b><span>${esc(d)}</span></div></li>`).join('');
  return `<img class="connect-mark" src="logo.png" alt="">
    <div>
      <h2>${title}</h2>
      <p class="lead ${cls}">${esc(lead)}</p>
      <ol class="steps">${steps}</ol>
      <p class="note">Xiaomi, POCO และ Redmi: เปิด "USB debugging (Security settings)" ด้วย ไม่อย่างนั้นจะเห็นจอแต่สั่งแตะไม่ได้</p>
      <details class="more"><summary>เสียบแล้วแต่ยังไม่ขึ้น</summary>
        <ul>
          <li>เปลี่ยนสายหรือพอร์ต USB สายชาร์จบางเส้นส่งข้อมูลไม่ได้</li>
          <li>ลงไดรเวอร์ USB ของยี่ห้อมือถือ เช่น Samsung USB Driver</li>
          <li>ในตัวเลือกสำหรับนักพัฒนา กด "เพิกถอนการอนุญาต USB debugging" แล้วเสียบใหม่</li>
        </ul>
        <button class="btn sm" data-act="adb-restart">เริ่มบริการเชื่อมต่อใหม่</button>
      </details>
    </div>`;
}
function renderConnect() {
  $('#connect').innerHTML = connectHTML();
  $$('.needs-device').forEach(el => {
    el.innerHTML = `<div class="nd"><img src="logo.png" alt=""><h2>ยังไม่ได้เชื่อมต่อมือถือ</h2>
      <p>${esc(S.dstate === 'unauthorized' ? 'กด "อนุญาต" บนหน้าจอมือถือ แล้วหน้านี้จะพร้อมใช้งาน' : 'เสียบมือถือด้วยสาย USB หรือเชื่อมต่อผ่าน Wi‑Fi แล้วหน้านี้จะพร้อมใช้งาน')}</p>
      <button class="btn" data-menu="guide">ดูวิธีเชื่อมต่อ</button></div>`;
  });
}
function showGuide() {
  const m = modal(`<div class="connect">${connectHTML()}</div><div class="modal-actions"><button class="btn primary" data-close>เข้าใจแล้ว</button></div>`, true);
  m.querySelector('[data-close]').onclick = closeModal;
}

/* ================================================================ home */
async function loadInfo() {
  if (!S.ready) return;
  const serial = S.current;
  const info = await quiet('device_info');
  if (!info || serial !== S.current) return;
  S.info = info; S.infoAt = Date.now();
  renderInfo();
}
function setMeter(id, pct, text, level) {
  const m = $(id);
  m.className = 'meter ' + (level || '');
  m.querySelector('.bar i').style.width = pct == null ? '0' : clamp(pct, 0, 100) + '%';
  m.querySelector('.meter-val').textContent = text;
}
function renderInfo() {
  const i = S.info;
  const d = S.devices.find(x => x.serial === S.current) || {};
  $('#dev-name').textContent = i.name || i.model || 'มือถือ Android';
  const parts = [];
  const brandModel = [i.brand, i.model].filter(Boolean).join(' ');
  if (brandModel && brandModel !== i.name) parts.push(`<span>${esc(brandModel)}</span>`);
  if (i.android) parts.push(`<span>Android ${esc(i.android)}</span>`);
  parts.push(`<span>${icon(d.transport === 'wifi' ? 'wifi' : 'usb', 'sm')}${d.transport === 'wifi' ? 'Wi‑Fi' : 'USB'}</span>`);
  $('#dev-sub').innerHTML = parts.join('');

  const b = i.battery;
  const btxt = b == null ? '—' : `${b}%${i.full ? ' เต็มแล้ว' : i.charging ? ' กำลังชาร์จ' : ''}`;
  setMeter('#m-battery', b, btxt, b == null ? '' : i.charging || b >= 40 ? 'good' : b >= 20 ? 'warn' : 'low');
  const sp = i.storage_total ? i.storage_used / i.storage_total * 100 : null;
  setMeter('#m-storage', sp, i.storage_total ? `${fmtBytes(i.storage_used)} จาก ${fmtBytes(i.storage_total)}` : '—', sp > 92 ? 'low' : sp > 80 ? 'warn' : '');
  const mu = i.mem_total ? i.mem_total - i.mem_avail : null;
  setMeter('#m-memory', i.mem_total ? mu / i.mem_total * 100 : null, i.mem_total ? `${fmtBytes(mu)} จาก ${fmtBytes(i.mem_total)}` : '—', '');

  const facts = [
    ['ระบบ', i.android ? `Android ${i.android} (API ${i.sdk})` : '—'],
    ['หน้าจอ', i.screen ? `${i.screen}${i.density ? ` (${i.density} dpi)` : ''}` : '—'],
    ['อุณหภูมิแบต', i.temp != null ? `${i.temp.toFixed(1)} °C` : '—'],
    ['แหล่งไฟ', i.power_source || 'ไม่ได้ชาร์จ'],
    ['IP Wi‑Fi', i.ip || 'ไม่ได้ต่อ Wi‑Fi'],
    ['เปิดเครื่องมาแล้ว', fmtUptime(i.uptime)],
    ['Serial', i.serial],
    ['ผู้ผลิต', i.brand || '—'],
  ];
  $('#facts').innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd title="${esc(v)}">${esc(v)}</dd></div>`).join('');
}

/* ================================================================ screen loop (มีลูปเดียวเสมอ) */
const loop = {
  token: 0,
  restart(delay = 0) {
    const t = ++this.token;
    const run = async () => {
      if (t !== this.token) return;
      let next = null;
      if (S.ready && document.visibilityState === 'visible') {
        if (S.page === 'home') {
          await grab('#home-shot', '#home-phone');
          next = 5000;
          if (Date.now() - S.infoAt > 20000) loadInfo();
        } else if (S.page === 'screen' && S.rate > 0) {
          await grab('#live', '#viewer');
          next = S.rate;
        }
      }
      if (t === this.token && next != null) setTimeout(run, next);
    };
    setTimeout(run, delay);
  },
};
async function grab(imgSel, phoneSel) {
  const serial = S.current;
  const f = await quiet('screen_frame', 1400);
  if (!f || serial !== S.current) return false;
  S.frame = f;
  $(imgSel).src = f.img;
  $(phoneSel).style.setProperty('--ar', `${f.w} / ${f.h}`);
  return true;
}
function setRate(r) {
  S.rate = r; store.set('rate', r);
  $$('#rate-seg button').forEach(b => b.classList.toggle('on', +b.dataset.rate === r));
  $('#live-empty').textContent = r ? 'กำลังโหลดภาพหน้าจอ' : 'กด "ปกติ" หรือ "เร็ว" เพื่อดูหน้าจอ';
  loop.restart();
}
function afterAction() {
  if (S.page !== 'screen') return;
  if (S.rate > 0) loop.restart(280);
  else setTimeout(() => grab('#live', '#viewer'), 300);
}

/* ---------- live view interaction */
function devPoint(e) {
  const img = $('#live');
  if (!S.frame || !img.getAttribute('src')) return null;
  const r = img.getBoundingClientRect();
  const ar = S.frame.w / S.frame.h;
  let w = r.width, h = r.height, ox = 0, oy = 0;
  if (r.width / r.height > ar) { w = h * ar; ox = (r.width - w) / 2; } else { h = w / ar; oy = (r.height - h) / 2; }
  const x = (e.clientX - r.left - ox) / w, y = (e.clientY - r.top - oy) / h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: Math.round(x * S.frame.w), y: Math.round(y * S.frame.h) };
}
function ring(e) {
  const scr = $('#viewer .phone-screen'), r = scr.getBoundingClientRect();
  const el = document.createElement('span');
  el.className = 'touch-ring';
  el.style.left = (e.clientX - r.left) + 'px'; el.style.top = (e.clientY - r.top) + 'px';
  scr.append(el);
  setTimeout(() => el.remove(), 500);
}
function bindViewer() {
  const v = $('#viewer');
  let down = null, wheelAt = 0, typeBuf = '', typeT = null;
  v.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    v.focus({ preventScroll: true });
    const p = devPoint(e);
    if (!p) return;
    down = { p, x: e.clientX, y: e.clientY, t: Date.now() };
    v.setPointerCapture(e.pointerId);
  });
  v.addEventListener('pointerup', async e => {
    if (!down) return;
    const d = down; down = null;
    const dist = Math.hypot(e.clientX - d.x, e.clientY - d.y), dt = Date.now() - d.t;
    try {
      if (dist < 6) {
        ring(e);
        if (dt > 550) await call('input_swipe', d.p.x, d.p.y, d.p.x, d.p.y, 650);
        else await call('input_tap', d.p.x, d.p.y);
      } else {
        const p2 = devPoint(e) || d.p;
        await call('input_swipe', d.p.x, d.p.y, p2.x, p2.y, clamp(dt, 80, 1500));
      }
    } catch { /* แจ้งแล้ว */ }
    afterAction();
  });
  v.addEventListener('contextmenu', e => { e.preventDefault(); sendKey('KEYCODE_BACK'); });
  v.addEventListener('wheel', e => {
    e.preventDefault();
    if (!S.frame || Date.now() - wheelAt < 350) return;
    wheelAt = Date.now();
    const p = devPoint(e) || { x: S.frame.w / 2, y: S.frame.h / 2 };
    const dy = (e.deltaY > 0 ? -1 : 1) * S.frame.h * 0.28;
    const y2 = clamp(p.y + dy, 5, S.frame.h - 5);
    call('input_swipe', p.x, p.y, p.x, y2, 180).then(afterAction, () => {});
  }, { passive: false });
  const KEYS = {
    Backspace: 'KEYCODE_DEL', Delete: 'KEYCODE_FORWARD_DEL', Enter: 'KEYCODE_ENTER', Escape: 'KEYCODE_BACK', Tab: 'KEYCODE_TAB',
    ArrowUp: 'KEYCODE_DPAD_UP', ArrowDown: 'KEYCODE_DPAD_DOWN', ArrowLeft: 'KEYCODE_DPAD_LEFT', ArrowRight: 'KEYCODE_DPAD_RIGHT',
  };
  v.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (KEYS[e.key]) { e.preventDefault(); flush(); sendKey(KEYS[e.key]); return; }
    if (e.key.length === 1) {
      e.preventDefault();
      typeBuf += e.key;
      clearTimeout(typeT); typeT = setTimeout(flush, 150);
    }
  });
  function flush() {
    clearTimeout(typeT);
    if (!typeBuf) return;
    const t = typeBuf; typeBuf = '';
    sendText(t, false);
  }
}
async function sendKey(code) {
  try { await call('input_key', code); } catch { return; }
  afterAction();
}
async function sendText(text, clear = true) {
  if (!text) return;
  let r;
  try { r = await call('input_text', text); } catch { return; }
  if (r.via === 'clipboard') {
    toast('ภาษาไทยส่งได้เมื่อเปิดจอสดอยู่ ข้อความถูกคัดลอกไว้แล้ว', 'warn', { action: { label: 'เปิดจอสด', fn: () => toggleMirror(true) } });
    return;
  }
  if (clear) $('#type-input').value = '';
  afterAction();
}

/* ================================================================ mirror / capture */
function setMirror(on) {
  S.mirror = on;
  const label = on ? 'ปิดจอสด' : 'เปิดจอสด', ic = on ? 'stop' : 'play';
  $$('#mirror-btn, [data-act="mirror"]').forEach(b => {
    b.classList.toggle('live', on);
    b.innerHTML = `${icon(ic)}<span>${label}</span>`;
  });
}
async function toggleMirror(forceOn) {
  try {
    if (S.mirror && forceOn !== true) { await call('mirror_stop'); setMirror(false); }
    else if (!S.mirror) { await call('mirror_start'); setMirror(true); }
  } catch { /* แจ้งแล้ว */ }
}
async function doScreenshot() {
  let p;
  try { p = await call('screenshot'); } catch { return; }
  toast('บันทึกภาพหน้าจอแล้ว', 'ok', { action: { label: 'เปิดดู', fn: () => quiet('open_path', p) } });
}
let recTimer = null;
function setRec(active, started = Date.now()) {
  S.rec = { active, started };
  clearInterval(recTimer);
  const paint = () => {
    const s = Math.floor((Date.now() - S.rec.started) / 1000);
    $$('.rec-label').forEach(l => { l.textContent = S.rec.active ? `หยุดอัด ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'อัดหน้าจอ'; });
    $$('[data-act="record"]').forEach(b => b.classList.toggle('recording', S.rec.active));
  };
  paint();
  if (active) recTimer = setInterval(paint, 1000);
}
async function toggleRecord() {
  const btns = $$('[data-act="record"]');
  if (S.rec.active) {
    btns.forEach(b => { b.disabled = true; });
    $$('.rec-label').forEach(l => { l.textContent = 'กำลังบันทึก'; });
    try {
      const r = await call('record_stop');
      setRec(false);
      toast('บันทึกวิดีโอแล้ว', 'ok', { action: { label: 'เปิดดู', fn: () => quiet('open_path', r.path) } });
    } catch { setRec(false); }
    btns.forEach(b => { b.disabled = false; });
  } else {
    try { await call('record_start'); setRec(true); } catch { /* แจ้งแล้ว */ }
  }
}

/* ================================================================ files */
const PLACES = [
  ['ที่เก็บข้อมูลหลัก', '/sdcard', 'home'], ['รูปจากกล้อง', '/sdcard/DCIM', 'camera'], ['ดาวน์โหลด', '/sdcard/Download', 'download'],
  ['รูปภาพ', '/sdcard/Pictures', 'image'], ['วิดีโอ', '/sdcard/Movies', 'video'], ['เพลง', '/sdcard/Music', 'music'],
  ['เอกสาร', '/sdcard/Documents', 'doc'], ['ทั้งเครื่อง', '/', 'box'],
];
function fileIcon(it) {
  if (it.kind === 'dir') return 'files';
  if (it.kind === 'link') return 'link';
  const ext = (it.name.split('.').pop() || '').toLowerCase();
  if (/^(jpe?g|png|gif|webp|heic|heif|bmp|svg)$/.test(ext)) return 'image';
  if (/^(mp4|mkv|mov|3gp|webm|avi|m4v)$/.test(ext)) return 'video';
  if (/^(mp3|m4a|aac|wav|flac|ogg|opus|amr)$/.test(ext)) return 'music';
  if (ext === 'apk') return 'box';
  if (/^(pdf|docx?|txt|xlsx?|pptx?|csv|md|json|xml|html?)$/.test(ext)) return 'doc';
  return 'file';
}
async function listFiles(path) {
  const F = S.files;
  $('#f-status').textContent = 'กำลังโหลด';
  let r;
  try { r = await api.files_list(path); } catch (e) {
    toast(errText(e), 'error'); $('#f-status').textContent = ''; return;
  }
  if (r.notDir) {
    if (await confirmBox({ title: 'รายการนี้เป็นไฟล์', body: 'ดาวน์โหลดมาที่คอมแล้วเปิดดูไหม', ok: 'ดาวน์โหลดและเปิด' })) pull([r.path], true);
    $('#f-status').textContent = '';
    return;
  }
  F.path = r.path; F.items = r.items; F.sel.clear(); F.anchor = null; F.filter = ''; F.loaded = true;
  $('#file-filter').value = '';
  renderCrumbs(); renderPlaces(); renderFiles();
}
function renderPlaces() {
  const cur = S.files.path;
  const best = PLACES.filter(([, p]) => cur === p || cur.startsWith(p === '/' ? '/' : p + '/')).sort((a, b) => b[1].length - a[1].length)[0];
  $('#places').innerHTML = PLACES.map(([l, p, ic]) => `<button data-path="${esc(p)}" class="${best && best[1] === p ? 'on' : ''}">${icon(ic)}<span>${l}</span></button>`).join('');
}
function renderCrumbs() {
  const p = S.files.path;
  let base, rest;
  if (p === '/sdcard' || p.startsWith('/sdcard/')) { base = ['ที่เก็บข้อมูลหลัก', '/sdcard']; rest = p.slice(7); }
  else { base = ['ทั้งเครื่อง', '/']; rest = p; }
  const segs = rest.split('/').filter(Boolean);
  let acc = base[1];
  const btns = [`<button data-path="${esc(base[1])}">${base[0]}</button>`];
  for (const s of segs) { acc = join(acc, s); btns.push(icon('chev-right', 'sm'), `<button data-path="${esc(acc)}" title="${esc(s)}">${esc(s)}</button>`); }
  $('#crumbs').innerHTML = btns.join('');
}
function renderFiles() {
  const F = S.files;
  const q = F.filter.toLowerCase();
  const dir = F.asc ? 1 : -1;
  F.view = F.items.filter(it => !q || it.name.toLowerCase().includes(q)).sort((a, b) => {
    if ((a.kind === 'file') !== (b.kind === 'file')) return a.kind === 'file' ? 1 : -1;
    if (F.sort === 'size') return ((a.size || 0) - (b.size || 0)) * dir;
    if (F.sort === 'date') return a.date.localeCompare(b.date) * dir;
    return a.name.localeCompare(b.name, 'th', { numeric: true, sensitivity: 'base' }) * dir;
  });
  $$('.thead [data-sort]').forEach(b => { b.classList.toggle('sorted', b.dataset.sort === F.sort); b.classList.toggle('asc', F.asc); });
  const rows = $('#f-rows');
  if (!F.view.length) {
    rows.innerHTML = q
      ? `<div class="empty"><b>ไม่พบไฟล์ที่ชื่อมีคำว่า "${esc(F.filter)}"</b>ลองค้นด้วยคำอื่น</div>`
      : `<div class="empty"><b>โฟลเดอร์นี้ว่าง</b>ลากไฟล์จากคอมมาวางที่นี่ หรือกด "อัปโหลด"</div>`;
  } else {
    rows.innerHTML = F.view.map((it, i) => {
      const full = join(F.path, it.name);
      return `<div class="row ${it.kind} ${F.sel.has(full) ? 'sel' : ''}" data-i="${i}">
        <label class="cb"><input type="checkbox" ${F.sel.has(full) ? 'checked' : ''} tabindex="-1"><span></span></label>
        <div class="name">${icon(fileIcon(it))}<span title="${esc(it.name)}">${esc(it.name)}</span></div>
        <div class="size">${it.kind === 'file' ? fmtBytes(it.size) : ''}</div>
        <div class="date">${esc(fmtDate(it.date))}</div></div>`;
    }).join('');
  }
  renderSelection();
  const dirs = F.items.filter(i => i.kind !== 'file').length, files = F.items.length - dirs;
  const total = F.items.reduce((a, i) => a + (i.size || 0), 0);
  $('#f-status').textContent = `${dirs} โฟลเดอร์ ${files} ไฟล์${files ? ` รวม ${fmtBytes(total)}` : ''}  ดับเบิลคลิกเพื่อเปิด  ลากไฟล์จากคอมมาวางเพื่ออัปโหลด`;
}
function renderSelection() {
  const F = S.files, n = F.sel.size;
  $$('#f-rows .row').forEach(r => {
    const it = F.view[+r.dataset.i]; const on = F.sel.has(join(F.path, it.name));
    r.classList.toggle('sel', on); r.querySelector('input').checked = on;
  });
  const all = $('#f-all');
  all.checked = n > 0 && n === F.view.length; all.indeterminate = n > 0 && n < F.view.length;
  $('#selbar').hidden = n === 0;
  $('#sel-count').textContent = `เลือก ${n} รายการ`;
  $('#f-rename').disabled = n !== 1;
}
function selectedPaths() { return [...S.files.sel]; }
function openItem(it) {
  const full = join(S.files.path, it.name);
  if (it.kind === 'file') pull([full], true);
  else listFiles(full);
}
async function pull(paths, open = false) {
  let r;
  try { r = await call('files_pull', paths, open); } catch { return; }
  if (!open || paths.length > 1) {
    toast(`ดาวน์โหลด ${paths.length} รายการแล้ว`, 'ok', { action: { label: 'เปิดโฟลเดอร์', fn: () => quiet('reveal_path', r.last) } });
  }
}
async function pushFiles(paths, dest) {
  let n;
  try { n = await call('files_push', paths, dest); } catch { return; }
  toast(`ส่ง ${n} รายการไปมือถือแล้ว`, 'ok');
  if (S.page === 'files' && S.files.path === dest) listFiles(dest);
}
function bindFiles() {
  $('#places').addEventListener('click', e => { const b = e.target.closest('[data-path]'); if (b) listFiles(b.dataset.path); });
  $('#crumbs').addEventListener('click', e => { const b = e.target.closest('[data-path]'); if (b) listFiles(b.dataset.path); });
  $('#file-filter').addEventListener('input', e => { S.files.filter = e.target.value; S.files.sel.clear(); renderFiles(); });
  $('#f-refresh').onclick = () => listFiles(S.files.path);
  $$('.thead [data-sort]').forEach(b => b.onclick = () => {
    const F = S.files;
    if (F.sort === b.dataset.sort) F.asc = !F.asc; else { F.sort = b.dataset.sort; F.asc = b.dataset.sort === 'name'; }
    renderFiles();
  });
  $('#f-all').onchange = e => {
    const F = S.files; F.sel.clear();
    if (e.target.checked) F.view.forEach(it => F.sel.add(join(F.path, it.name)));
    renderSelection();
  };
  const rows = $('#f-rows');
  rows.addEventListener('click', e => {
    const r = e.target.closest('.row'); if (!r) return;
    const F = S.files, i = +r.dataset.i, full = join(F.path, F.view[i].name);
    if (e.target.closest('.cb')) {
      e.preventDefault();
      F.sel.has(full) ? F.sel.delete(full) : F.sel.add(full); F.anchor = i;
    } else if (e.shiftKey && F.anchor != null) {
      F.sel.clear();
      const [a, b] = [Math.min(F.anchor, i), Math.max(F.anchor, i)];
      for (let k = a; k <= b; k++) F.sel.add(join(F.path, F.view[k].name));
    } else if (e.ctrlKey) {
      F.sel.has(full) ? F.sel.delete(full) : F.sel.add(full); F.anchor = i;
    } else {
      F.sel.clear(); F.sel.add(full); F.anchor = i;
    }
    renderSelection();
  });
  rows.addEventListener('dblclick', e => {
    const r = e.target.closest('.row'); if (!r || e.target.closest('.cb')) return;
    openItem(S.files.view[+r.dataset.i]);
  });
  rows.addEventListener('keydown', e => {
    const F = S.files;
    if (e.key === 'Enter' && F.sel.size === 1) { const p = [...F.sel][0]; const it = F.view.find(x => join(F.path, x.name) === p); if (it) openItem(it); }
    else if (e.key === 'Delete' && F.sel.size) deleteSelected();
    else if (e.key === 'Backspace') listFiles(parent(F.path));
    else if (e.key === 'a' && e.ctrlKey) { e.preventDefault(); F.view.forEach(it => F.sel.add(join(F.path, it.name))); renderSelection(); }
    else if (e.key === 'F2' && F.sel.size === 1) renameSelected();
  });
  $('#f-clear').onclick = () => { S.files.sel.clear(); renderSelection(); };
  $('#f-download').onclick = () => pull(selectedPaths());
  $('#f-rename').onclick = renameSelected;
  $('#f-delete').onclick = deleteSelected;
  $('#f-mkdir').onclick = async () => {
    const name = await promptBox({ title: 'สร้างโฟลเดอร์ใหม่', value: 'โฟลเดอร์ใหม่', ok: 'สร้าง' });
    if (!name) return;
    try { await call('files_mkdir', S.files.path, name); } catch { return; }
    toast(`สร้างโฟลเดอร์ "${name}" แล้ว`, 'ok'); listFiles(S.files.path);
  };
  const upload = async folder => {
    closeMenus();
    let n;
    try { n = await call('files_push_dialog', S.files.path, folder); } catch { return; }
    if (n) { toast(`ส่ง ${n} รายการไปมือถือแล้ว`, 'ok'); listFiles(S.files.path); }
  };
  $('#f-upload').onclick = () => upload(false);
  $('#f-upload-more').onclick = e => { e.stopPropagation(); const m = $('#upload-menu'); const show = m.hidden; closeMenus(); m.hidden = !show; };
  $('#upload-menu').addEventListener('click', e => { const b = e.target.closest('[data-up]'); if (b) upload(b.dataset.up === 'folder'); });
}
async function renameSelected() {
  const p = selectedPaths()[0]; if (!p) return;
  const old = p.split('/').pop();
  const name = await promptBox({ title: 'เปลี่ยนชื่อ', value: old, ok: 'เปลี่ยนชื่อ' });
  if (!name || name === old) return;
  try { await call('files_rename', p, name); } catch { return; }
  toast('เปลี่ยนชื่อแล้ว', 'ok'); listFiles(S.files.path);
}
async function deleteSelected() {
  const paths = selectedPaths(); if (!paths.length) return;
  const ok = await confirmBox({
    title: `ลบ ${paths.length} รายการออกจากมือถือ`, body: 'ลบแล้วกู้คืนไม่ได้ ไฟล์จะไม่ไปอยู่ในถังขยะ',
    items: paths.map(p => p.split('/').pop()), ok: 'ลบถาวร', danger: true,
  });
  if (!ok) return;
  try { await call('files_delete', paths); } catch { return; }
  toast(`ลบ ${paths.length} รายการแล้ว`, 'ok'); listFiles(S.files.path);
}

/* ================================================================ apps */
const INSTALLERS = { 'com.android.vending': 'Google Play', 'com.sec.android.app.samsungapps': 'Galaxy Store', 'com.xiaomi.market': 'GetApps', 'com.huawei.appmarket': 'AppGallery', 'com.heytap.market': 'App Market', 'com.android.packageinstaller': 'ติดตั้งจากไฟล์', 'com.google.android.packageinstaller': 'ติดตั้งจากไฟล์' };
/* Android ไม่ให้อ่านชื่อแอพผ่าน adb โดยตรง จึงใช้ชื่อจริงของแอพยอดนิยม และเดาจากชื่อแพ็กเกจสำหรับแอพอื่น */
const KNOWN_APPS = {
  'jp.naver.line.android': 'LINE', 'com.facebook.katana': 'Facebook', 'com.facebook.orca': 'Messenger', 'com.facebook.lite': 'Facebook Lite',
  'com.instagram.android': 'Instagram', 'com.instagram.barcelona': 'Threads', 'com.zhiliaoapp.musically': 'TikTok', 'com.ss.android.ugc.trill': 'TikTok',
  'com.google.android.youtube': 'YouTube', 'com.google.android.apps.youtube.music': 'YouTube Music', 'com.twitter.android': 'X',
  'com.whatsapp': 'WhatsApp', 'org.telegram.messenger': 'Telegram', 'com.discord': 'Discord', 'us.zoom.videomeetings': 'Zoom',
  'com.microsoft.teams': 'Microsoft Teams', 'com.shopee.th': 'Shopee', 'com.lazada.android': 'Lazada', 'com.grabtaxi.passenger': 'Grab',
  'com.lineman.app': 'LINE MAN', 'com.global.foodpanda.android': 'foodpanda', 'com.robinhood.thailand': 'Robinhood',
  'com.kasikorn.retail.mbanking.wap': 'K PLUS', 'com.scb.phone': 'SCB EASY', 'ktbcs.netbank': 'Krungthai NEXT', 'com.ktb.customer.qr': 'เป๋าตัง',
  'com.bbl.mobilebanking': 'Bangkok Bank', 'com.krungsri.kma': 'KMA', 'com.ttbbank.oneapp': 'ttb touch', 'com.gsb.mymo': 'MyMo',
  'com.truemoney.wallet': 'TrueMoney', 'th.co.truecorp.trueid': 'TrueID', 'com.ais.mimo.eservice': 'myAIS', 'com.dtac.dtacone': 'dtac',
  'com.netflix.mediaclient': 'Netflix', 'com.spotify.music': 'Spotify', 'com.disney.disneyplus': 'Disney+', 'com.viu.phone': 'Viu',
  'com.android.chrome': 'Chrome', 'com.google.android.gm': 'Gmail', 'com.google.android.apps.maps': 'Google Maps',
  'com.google.android.apps.photos': 'Google Photos', 'com.google.android.apps.docs': 'Google Drive', 'com.google.android.calendar': 'Google Calendar',
  'com.android.vending': 'Play Store', 'com.google.android.gms': 'Google Play services', 'com.google.android.googlequicksearchbox': 'Google',
  'com.google.android.apps.messaging': 'Messages', 'com.google.android.dialer': 'Phone', 'com.google.android.contacts': 'Contacts',
  'com.google.android.keep': 'Keep', 'com.google.android.apps.translate': 'Google Translate', 'com.canva.editor': 'Canva',
  'com.lemon.lvoverseas': 'CapCut', 'com.microsoft.office.outlook': 'Outlook', 'com.microsoft.office.officehubrow': 'Microsoft 365',
  'com.agoda.mobile.consumer': 'Agoda', 'com.booking': 'Booking.com', 'com.airbnb.android': 'Airbnb', 'com.cpall.allonline': '7-Eleven',
  'com.sec.android.app.camera': 'Camera', 'com.sec.android.gallery3d': 'Gallery', 'com.samsung.android.messaging': 'Messages',
  'com.android.settings': 'Settings', 'com.miui.gallery': 'Gallery', 'com.android.camera': 'Camera',
};
const GENERIC = /^(com|org|net|co|th|jp|io|app|apps|android|mobile|client|main|lite|phone|wap|retail|mbanking|customer|qr|global|consumer|th\d*|prod|release|ui|go)$/i;
function appTitle(pkg) {
  if (KNOWN_APPS[pkg]) return KNOWN_APPS[pkg];
  const parts = pkg.split('.');
  const tail = parts[parts.length - 1];
  let t = tail;
  if (GENERIC.test(tail) || tail.length <= 3) t = parts.slice(1).find(p => !GENERIC.test(p) && p.length > 2) || tail;
  t = t.replace(/[_-]+/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}
function avatar(pkg, cls = '') {
  let h = 0; for (const c of pkg) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="avatar ${cls}" style="background:hsl(${h} 32% 68%)">${esc(appTitle(pkg).charAt(0))}</span>`;
}
async function loadApps() {
  const A = S.apps, t = ++A.token;
  $('#app-status').textContent = 'กำลังโหลด';
  let list;
  try { list = await call('apps_list', A.kind); } catch { $('#app-status').textContent = ''; return; }
  if (t !== A.token) return;
  A.list = list; A.loaded = true;
  renderApps();
  if (A.sel && !list.find(x => x.pkg === A.sel)) { A.sel = null; renderAppDetail(null); }
}
function renderApps() {
  const A = S.apps, q = A.filter.toLowerCase();
  $$('#app-kind button').forEach(b => b.classList.toggle('on', b.dataset.kind === A.kind));
  const view = A.list.filter(a => !q || a.pkg.toLowerCase().includes(q));
  $('#app-list').innerHTML = view.length ? view.map(a => `<button class="app-row ${a.pkg === A.sel ? 'sel' : ''}" data-pkg="${esc(a.pkg)}">
      ${avatar(a.pkg)}<span class="meta"><b>${esc(appTitle(a.pkg))}</b><small>${esc(a.pkg)}</small></span>
      ${a.disabled ? '<span class="tag">ปิดใช้งาน</span>' : ''}</button>`).join('')
    : `<div class="empty"><b>${q ? 'ไม่พบแอพที่ตรงกับคำค้น' : A.kind === 'disabled' ? 'ไม่มีแอพที่ปิดใช้งานอยู่' : 'ไม่มีแอพในหมวดนี้'}</b>${q ? 'ลองค้นด้วยชื่อแพ็กเกจ เช่น line หรือ facebook' : ''}</div>`;
  $('#app-status').textContent = `แสดง ${view.length} จาก ${A.list.length} แอพ  ชื่อของแอพที่ไม่รู้จักเดาจากชื่อแพ็กเกจ`;
}
async function selectApp(pkg) {
  S.apps.sel = pkg; renderApps();
  $('#app-detail').innerHTML = `${avatar(pkg)}<h2>${esc(appTitle(pkg))}</h2><p class="pkg">${esc(pkg)}</p><p class="muted">กำลังโหลดรายละเอียด</p>`;
  const d = await quiet('app_detail', pkg);
  if (S.apps.sel === pkg) renderAppDetail(d || { pkg, error: true });
}
function renderAppDetail(d) {
  const el = $('#app-detail');
  if (!d) { el.innerHTML = '<p class="placeholder">เลือกแอพทางซ้ายเพื่อดูรายละเอียดและจัดการ</p>'; return; }
  const facts = d.error ? [] : [
    ['เวอร์ชัน', d.version ? `${d.version}${d.code ? ` (${d.code})` : ''}` : '—'],
    ['ขนาดไฟล์แอพ', fmtBytes(d.size)],
    ['ติดตั้งเมื่อ', fmtDate(d.installed)],
    ['อัปเดตล่าสุด', fmtDate(d.updated)],
    ['ติดตั้งจาก', INSTALLERS[d.installer] || (d.installer && d.installer !== 'null' ? d.installer : d.system ? 'มากับเครื่อง' : 'ไม่ทราบ')],
    ['ประเภท', d.system ? 'แอพระบบ' : 'แอพที่ติดตั้งเอง'],
    ['สถานะ', d.disabled ? 'ปิดใช้งานอยู่' : 'ใช้งานได้'],
  ];
  el.innerHTML = `${avatar(d.pkg)}<h2>${esc(appTitle(d.pkg))}</h2><p class="pkg">${esc(d.pkg)}</p>
    <dl class="facts">${facts.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <div class="app-actions">
      <button class="btn" data-app="launch" ${d.disabled ? 'disabled' : ''}>${icon('play')}<span>เปิดแอพ</span></button>
      <button class="btn" data-app="stop">${icon('stop')}<span>บังคับหยุด</span></button>
      <button class="btn" data-app="pull">${icon('download')}<span>ดึงไฟล์ APK</span></button>
      <button class="btn" data-app="toggle">${icon('ban')}<span>${d.disabled ? 'เปิดใช้งาน' : 'ปิดใช้งาน'}</span></button>
      <button class="btn danger" data-app="clear">${icon('broom')}<span>ล้างข้อมูล</span></button>
      ${d.system ? '' : `<button class="btn danger" data-app="uninstall">${icon('trash')}<span>ถอนการติดตั้ง</span></button>`}
    </div>`;
  el._d = d;
}
async function appAction(act) {
  const d = $('#app-detail')._d; if (!d) return;
  const name = appTitle(d.pkg);
  try {
    if (act === 'launch') { await call('app_launch', d.pkg); toast(`เปิด ${name} บนมือถือแล้ว`, 'ok'); }
    else if (act === 'stop') { await call('app_stop', d.pkg); toast(`หยุด ${name} แล้ว`, 'ok'); }
    else if (act === 'pull') {
      const p = await call('app_pull', d.pkg);
      toast(`ดึง APK ของ ${name} แล้ว`, 'ok', { action: { label: 'เปิดโฟลเดอร์', fn: () => quiet('reveal_path', p) } });
    } else if (act === 'clear') {
      if (!await confirmBox({ title: `ล้างข้อมูล ${name}`, body: 'การล็อกอิน การตั้งค่า และข้อมูลทั้งหมดในแอพนี้จะหายถาวร', ok: 'ล้างข้อมูล', danger: true })) return;
      await call('app_clear', d.pkg); toast(`ล้างข้อมูล ${name} แล้ว`, 'ok');
    } else if (act === 'toggle') {
      if (!d.disabled && !await confirmBox({ title: `ปิดใช้งาน ${name}`, body: 'แอพจะหายจากหน้าจอและหยุดทำงาน เปิดกลับได้ทุกเมื่อจากแท็บ "ปิดใช้งานอยู่"', ok: 'ปิดใช้งาน', danger: d.system })) return;
      await call('app_set_enabled', d.pkg, d.disabled);
      toast(`${d.disabled ? 'เปิด' : 'ปิด'}ใช้งาน ${name} แล้ว`, 'ok');
      loadApps(); selectApp(d.pkg);
    } else if (act === 'uninstall') {
      if (!await confirmBox({ title: `ถอนการติดตั้ง ${name}`, body: 'แอพและข้อมูลในแอพจะถูกลบออกจากมือถือ', ok: 'ถอนการติดตั้ง', danger: true })) return;
      await call('app_uninstall', d.pkg); toast(`ถอน ${name} แล้ว`, 'ok');
      S.apps.sel = null; renderAppDetail(null); loadApps();
    }
  } catch { /* แจ้งแล้ว */ }
}
function installSummary(results) {
  if (!results || !results.length) return;
  const ok = results.filter(r => r.ok).length;
  if (ok === results.length) toast(ok === 1 ? `ติดตั้ง ${results[0].name} แล้ว` : `ติดตั้งแล้ว ${ok} แอพ`, 'ok');
  else toast(results.filter(r => !r.ok).map(r => `${r.name}: ${r.error}`).join('\n'), 'error');
  S.apps.loaded = false;
  if (S.page === 'apps') loadApps();
}
async function installApks(paths) {
  try { installSummary(await call('app_install', paths)); } catch { /* แจ้งแล้ว */ }
}
function bindApps() {
  $('#app-kind').addEventListener('click', e => {
    const b = e.target.closest('[data-kind]'); if (!b || b.dataset.kind === S.apps.kind) return;
    S.apps.kind = b.dataset.kind; S.apps.list = []; renderApps(); loadApps();
  });
  $('#app-filter').addEventListener('input', e => { S.apps.filter = e.target.value; renderApps(); });
  $('#app-list').addEventListener('click', e => { const b = e.target.closest('[data-pkg]'); if (b) selectApp(b.dataset.pkg); });
  $('#app-detail').addEventListener('click', e => { const b = e.target.closest('[data-app]'); if (b) appAction(b.dataset.app); });
  $('#app-install').onclick = async () => { try { installSummary(await call('app_install_dialog')); } catch { /* แจ้งแล้ว */ } };
}

/* ================================================================ tools */
function renderWifiList() {
  const w = S.devices.filter(d => d.transport === 'wifi');
  $('#wifi-list').innerHTML = w.map(d => `<div class="wifi-item">${icon('wifi', 'sm')}<span>${esc(d.model || d.serial)} <small class="muted">${esc(d.serial)}</small></span>
    <button class="btn sm ghost" data-disc="${esc(d.serial)}">ตัดการเชื่อมต่อ</button></div>`).join('');
}
function renderLog() {
  $('#log').innerHTML = S.logs.slice().reverse().map(l => `<li><time>${esc(l.t)}</time><span class="${esc(l.level)}">${esc(l.msg)}</span></li>`).join('')
    || '<li><time></time><span class="muted">ยังไม่มีรายการ</span></li>';
}
function termWrite(html) { const t = $('#term-out'); t.insertAdjacentHTML('beforeend', html); t.scrollTop = t.scrollHeight; }
function bindTools() {
  $('#wifi-enable').onclick = async () => {
    try { const a = await call('wifi_enable'); toast(`เชื่อมต่อแล้วที่ ${a} ถอดสาย USB ได้เลย`, 'ok'); } catch { /* แจ้งแล้ว */ }
  };
  const connect = async () => { const v = $('#wifi-addr').value; try { const a = await call('wifi_connect', v); toast(`เชื่อมต่อ ${a} แล้ว`, 'ok'); $('#wifi-addr').value = ''; } catch { /* แจ้งแล้ว */ } };
  $('#wifi-connect').onclick = connect;
  $('#wifi-addr').onkeydown = e => { if (e.key === 'Enter') connect(); };
  $('#wifi-pair').onclick = async () => {
    try {
      await call('wifi_pair', $('#pair-addr').value, $('#pair-code').value);
      toast('จับคู่แล้ว ใส่ที่อยู่ IP และพอร์ตที่แสดงบนหน้า "แก้ไขข้อบกพร่องผ่าน Wi‑Fi" ในช่องด้านบน แล้วกดเชื่อมต่อ', 'ok', { ms: 10000 });
    } catch { /* แจ้งแล้ว */ }
  };
  $('#wifi-list').addEventListener('click', e => { const b = e.target.closest('[data-disc]'); if (b) quiet('wifi_disconnect', b.dataset.disc); });
  $$('[data-reboot]').forEach(b => b.onclick = async () => {
    const mode = b.dataset.reboot;
    const label = { '': 'รีสตาร์ทมือถือ', recovery: 'เข้าโหมด Recovery', bootloader: 'เข้าโหมด Bootloader' }[mode];
    if (!S.ready) { toast('ยังไม่ได้เชื่อมต่อมือถือ', 'warn'); return; }
    if (!await confirmBox({ title: `${label}ตอนนี้`, body: 'แอพที่เปิดอยู่บนมือถือจะถูกปิด และการเชื่อมต่อจะหลุดระหว่างรีสตาร์ท', ok: label })) return;
    try { await call('reboot', mode); toast(`สั่ง${label}แล้ว`, 'ok'); } catch { /* แจ้งแล้ว */ }
  });
  const runCmd = async () => {
    const inp = $('#term-in'), cmd = inp.value.trim(); if (!cmd) return;
    if (!S.ready) { toast('ยังไม่ได้เชื่อมต่อมือถือ', 'warn'); return; }
    S.history.push(cmd); S.hi = S.history.length; inp.value = '';
    termWrite(`<div class="cmd">$ ${esc(cmd)}</div>`);
    try {
      const r = await api.shell(cmd);
      termWrite(`${esc(r.out)}${r.out ? '\n' : ''}<div class="code">รหัสจบ ${r.code}</div>\n`);
    } catch (e) { termWrite(`<div class="code">${esc(errText(e))}</div>\n`); }
  };
  $('#term-in').onkeydown = e => {
    if (e.key === 'Enter') runCmd();
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      S.hi = clamp(S.hi + (e.key === 'ArrowUp' ? -1 : 1), 0, S.history.length);
      e.target.value = S.history[S.hi] || '';
    }
  };
  $('#term-clear').onclick = () => { $('#term-out').innerHTML = ''; };
  $('#open-save-dir').onclick = () => call('open_save_dir', '').catch(() => {});
}

/* ================================================================ settings */
function renderSettings() {
  const st = S.settings;
  $$('[data-set]').forEach(i => { i.checked = !!st[i.dataset.set]; });
  $$('#quality-seg button').forEach(b => b.classList.toggle('on', b.dataset.q === st.quality));
  $('#save-dir').textContent = st.save_dir;
  $('#about-version').textContent = `เวอร์ชัน ${S.version}`;
}
function bindSettings() {
  $$('[data-set]').forEach(i => i.onchange = async () => {
    try { S.settings = await call('settings_set', i.dataset.set, i.checked); } catch { i.checked = !i.checked; }
  });
  $('#quality-seg').addEventListener('click', async e => {
    const b = e.target.closest('[data-q]'); if (!b) return;
    try { S.settings = await call('settings_set', 'quality', b.dataset.q); renderSettings(); } catch { /* แจ้งแล้ว */ }
    if (S.mirror) toast('คุณภาพใหม่จะใช้ตอนเปิดจอสดครั้งถัดไป', 'info');
  });
  $('#save-dir-open').onclick = () => call('open_save_dir', '').catch(() => {});
  $('#save-dir-change').onclick = async () => { try { S.settings = await call('pick_save_dir'); renderSettings(); } catch { /* แจ้งแล้ว */ } };
  $('#check-update').onclick = () => checkUpdate(false);
  $('#open-github').onclick = () => quiet('open_url_pc', `https://github.com/${S.repo}`);
}
async function checkUpdate(silent) {
  const r = silent ? await quiet('check_update') : await call('check_update').catch(() => null);
  if (!r) return;
  if (r.newer) toast(`มีเวอร์ชันใหม่ ${r.latest} (ตอนนี้ ${r.current})`, 'ok', { sticky: true, action: { label: 'ดาวน์โหลด', fn: () => quiet('open_url_pc', r.url) } });
  else if (!silent) toast(`ใช้เวอร์ชันล่าสุดอยู่แล้ว (${r.current})`, 'ok');
}

/* ================================================================ drag & drop */
function bindDrop() {
  let depth = 0;
  const show = () => {
    const files = S.page === 'files';
    $('#drop-title').textContent = !S.ready ? 'เสียบมือถือก่อน' : S.page === 'apps' ? 'วางไฟล์ .apk เพื่อติดตั้ง' : 'วางไฟล์เพื่อส่งไปมือถือ';
    $('#drop-sub').textContent = !S.ready ? 'ยังไม่ได้เชื่อมต่อมือถือ' : S.page === 'apps' ? 'ติดตั้งหลายแอพพร้อมกันได้'
      : files ? `ปลายทาง ${S.files.path}` : 'ไฟล์ .apk จะถูกติดตั้ง ไฟล์อื่นจะไปที่ Download';
    $('#drop-overlay').hidden = false;
  };
  const hide = () => { depth = 0; $('#drop-overlay').hidden = true; };
  document.addEventListener('dragenter', e => { if (![...(e.dataTransfer?.types || [])].includes('Files')) return; depth++; show(); });
  document.addEventListener('dragleave', () => { if (--depth <= 0) hide(); });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => { e.preventDefault(); hide(); });
}
async function onDropped(paths) {
  $('#drop-overlay').hidden = true;
  if (!S.ready) { toast('เสียบมือถือก่อน แล้วค่อยลากไฟล์มาวาง', 'warn'); return; }
  const apks = paths.filter(p => /\.apk$/i.test(p));
  if (S.page === 'apps') {
    if (!apks.length) { toast('หน้านี้รับเฉพาะไฟล์ .apk', 'warn'); return; }
    return installApks(apks);
  }
  if (S.page === 'files') return pushFiles(paths, S.files.path);
  if (apks.length === paths.length) {
    if (await confirmBox({ title: `ติดตั้ง ${apks.length} แอพ`, items: apks.map(p => p.split(/[\\/]/).pop()), ok: 'ติดตั้ง' })) installApks(apks);
    return;
  }
  if (await confirmBox({ title: `ส่ง ${paths.length} รายการไปมือถือ`, body: 'ไฟล์จะไปอยู่ในโฟลเดอร์ Download บนมือถือ', items: paths.map(p => p.split(/[\\/]/).pop()), ok: 'ส่งไฟล์' })) {
    pushFiles(paths, '/sdcard/Download');
  }
}

/* ================================================================ events from Python */
window.GG = {
  onEvent(ev, data) {
    if (!S.inited) { pending.push([ev, data]); return; }
    if (ev === 'devices') applyDevices(data);
    else if (ev === 'log') { S.logs.push(data); if (S.logs.length > 300) S.logs.shift(); renderLog(); }
    else if (ev === 'mirror') { setMirror(data.running); if (data.error) toast(data.error, 'error'); }
    else if (ev === 'record') {
      setRec(false);
      if (data.error) toast(data.error, 'error');
      else toast('อัดครบ 3 นาทีแล้ว บันทึกวิดีโอเรียบร้อย', 'ok', { action: { label: 'เปิดดู', fn: () => quiet('open_path', data.path) } });
    } else if (ev === 'task') {
      const id = 'task' + data.id;
      if (data.finished) {
        const el = toastMap.get(id);
        if (data.error) toast(data.error, 'error', { id });
        else if (el) dropToast(el, id);
      } else {
        toast(data.label, 'info', { id, sticky: true, progress: data.total > 1 ? data.done / data.total : -1 });
      }
    } else if (ev === 'dropped') onDropped(data);
  },
};

/* ================================================================ bootstrap */
function bindShell() {
  $$('.rail-btn').forEach(b => b.onclick = () => go(b.dataset.page));
  $('#device-switch').onclick = e => {
    e.stopPropagation();
    const m = $('#device-menu'); const show = m.hidden; closeMenus();
    if (show) { renderDeviceMenu(); m.hidden = false; }
  };
  $('#device-menu').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    closeMenus();
    if (b.dataset.serial && b.dataset.serial !== S.current) {
      const st = await call('select_device', b.dataset.serial).catch(() => null);
      if (st) applyDevices(st);
    }
  });
  document.addEventListener('click', e => {
    const m = e.target.closest('[data-menu]');
    if (m) { closeMenus(); if (m.dataset.menu === 'wifi') go('tools'); else showGuide(); return; }
    const a = e.target.closest('[data-act]');
    if (a) {
      const act = a.dataset.act;
      if (act === 'mirror') toggleMirror();
      else if (act === 'screenshot') doScreenshot();
      else if (act === 'record') toggleRecord();
      else if (act === 'unlock') call('unlock').then(afterAction, () => {});
      else if (act === 'adb-restart') call('adb_restart').then(() => toast('เริ่มบริการเชื่อมต่อใหม่แล้ว', 'ok'), () => {});
      return;
    }
    const k = e.target.closest('[data-key]');
    if (k) { sendKey(k.dataset.key); return; }
    const sh = e.target.closest('[data-shade]');
    if (sh) { call('shade', sh.dataset.shade).then(afterAction, () => {}); return; }
    if (!e.target.closest('.menu')) closeMenus();
  });
  $('#adb-restart').onclick = () => call('adb_restart').then(() => toast('เริ่มบริการเชื่อมต่อใหม่แล้ว', 'ok'), () => {});
  $('#mirror-btn').onclick = () => toggleMirror();
  $('#modal').addEventListener('mousedown', e => { if (e.target.id === 'modal' && $('#modal')._close) $('#modal')._close(); });
  $('#rate-seg').addEventListener('click', e => { const b = e.target.closest('[data-rate]'); if (b) setRate(+b.dataset.rate); });
  $('#type-input').onkeydown = e => { if (e.key === 'Enter') sendText(e.target.value); };
  $('#type-send').onclick = () => sendText($('#type-input').value);
  $('#open-link').onclick = async () => {
    try { const u = await call('open_link', $('#type-input').value); toast(`เปิด ${u} บนมือถือแล้ว`, 'ok'); $('#type-input').value = ''; } catch { /* แจ้งแล้ว */ }
  };
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeMenus();
    if (e.ctrlKey && /^[1-6]$/.test(e.key)) { e.preventDefault(); go(Object.keys(TITLES)[+e.key - 1]); }
  });
  document.addEventListener('visibilitychange', () => loop.restart());
}

async function init(apiObj) {
  if (S.inited) return;
  api = apiObj;
  bindShell(); bindViewer(); bindFiles(); bindApps(); bindTools(); bindSettings(); bindDrop();
  const st = await api.get_state();
  S.tools = st.tools; S.settings = st.settings; S.version = st.version; S.repo = st.repo; S.logs = st.logs || [];
  renderSettings(); renderLog(); renderPlaces(); renderAppDetail(null);
  setMirror(st.mirror);
  setRec(st.recording.active, Date.now() - st.recording.elapsed * 1000);
  setRate(S.rate);
  S.inited = true;
  applyDevices(st);
  go('home');
  pending.splice(0).forEach(([ev, data]) => window.GG.onEvent(ev, data));
  if (!st.tools.scrcpy) toast('ไม่พบ scrcpy ปุ่มจอสดจะใช้ไม่ได้ ติดตั้งโปรแกรมใหม่ด้วยตัวติดตั้ง', 'warn', { sticky: true });
  if (st.settings.check_updates) setTimeout(() => checkUpdate(true), 2500);
}

window.addEventListener('pywebviewready', () => init(window.pywebview.api));
if (window.pywebview?.api?.get_state) init(window.pywebview.api);
if (/[?&]demo/.test(location.search)) {
  const s = document.createElement('script'); s.src = 'demo.js'; document.head.append(s);
}
