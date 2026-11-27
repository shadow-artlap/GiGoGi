'use strict';
/* GiGoGi UI — ทำงานคู่กับ gigogi/api.py ผ่าน window.pywebview.api */

/* เก็บ error ของหน้าเว็บไว้ ให้ --smoke รายงานได้ (ช่วยหาบั๊กที่เกิดเฉพาะในหน้าต่างจริง) */
window.__ggErrors = [];
window.addEventListener('error', e => window.__ggErrors.push(String(e.message || e.error)));
window.addEventListener('unhandledrejection', e => window.__ggErrors.push(String(e.reason?.message || e.reason)));

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
  inited: false, page: 'all', ready: false, dstate: null, devices: [], current: null,
  tools: { adb: true, scrcpy: true }, settings: {}, version: '', repo: '', logs: [],
  mirrors: new Set(), briefs: {}, rec: { active: false, started: 0 }, info: null, infoAt: 0, frame: null,
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
function promptBox({ title, body = '', value = '', ok = 'บันทึก', placeholder = '', allowEmpty = false }) {
  return dialog(() => {
    const m = modal(`<h3>${esc(title)}</h3>${body ? `<p>${esc(body)}</p>` : ''}<input class="input" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false">`
      + `<div class="modal-actions"><button class="btn ghost" data-r="0">ยกเลิก</button><button class="btn primary" data-r="1">${esc(ok)}</button></div>`);
    const inp = m.querySelector('input');
    const submit = () => { const v = inp.value.trim(); if (v || allowEmpty) m._done(v); };
    m.querySelector('[data-r="0"]').onclick = () => m._done(null);
    m.querySelector('[data-r="1"]').onclick = submit;
    inp.onkeydown = e => { if (e.key === 'Enter') submit(); };
    setTimeout(() => { inp.focus(); const dot = value.lastIndexOf('.'); inp.setSelectionRange(0, dot > 0 ? dot : value.length); }, 0);
    return m;
  }, 'input');
}

/* ================================================================ navigation */
const TITLES = { all: 'ทุกเครื่อง', screen: 'หน้าจอ', files: 'ไฟล์', apps: 'แอพ', schedule: 'ตั้งเวลา', tools: 'เครื่องมือ', settings: 'ตั้งค่า' };
function go(page) {
  S.page = page;
  document.body.dataset.page = page;
  $$('.rail-btn').forEach(b => b.classList.toggle('active', b.dataset.page === page));
  $$('.page').forEach(p => { p.hidden = p.id !== 'page-' + page; });
  $('#page-title').textContent = TITLES[page];
  closeMenus();
  onPageShown();
}
function updateViewerHint() {
  const el = $('#viewer-hint');
  if (el) el.textContent = S.settings.input_mode === 'remote'
    ? 'โหมดใช้ผ่านรีโมต: คลิกที่ภาพนี้เพื่อแตะแบบสัมผัสจริง (ใช้ได้แม้ควบคุมผ่านรีโมต และกับหน้าที่แตะปกติไม่ได้) พิมพ์บนคีย์บอร์ดได้เลย'
    : 'คลิกเพื่อแตะ ลากเพื่อปัด คลิกขวาเพื่อย้อนกลับ พิมพ์บนคีย์บอร์ดได้เลย';
}
function onPageShown() {
  loop.restart();
  if (S.page === 'screen') updateViewerHint();
  if (S.page === 'schedule') renderSchedules();
  if (!S.ready) return;
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
  renderSwitch(); renderConnect(); renderWifiList(); renderTiles();
  $('#mirror-btn').disabled = !S.ready;
  setMirrors([...S.mirrors]);
  const fresh = S.ready && (!was || prev !== S.current);
  if (fresh) {
    S.frame = null;
    Object.assign(S.files, { path: '/sdcard', items: [], view: [], loaded: false, filter: '' }); S.files.sel.clear();
    Object.assign(S.apps, { list: [], loaded: false, sel: null });
    $('#live').removeAttribute('src');
    renderAppDetail(null);
    $$('.phone').forEach(p => p.classList.remove('lit'));
    requestAnimationFrame(() => requestAnimationFrame(() => $$('.phone').forEach(p => p.classList.add('lit'))));
  }
  if (was && !S.ready) {
    toast(S.dstate ? deviceSub({ state: S.dstate }) : 'มือถือหลุดการเชื่อมต่อแล้ว', 'warn');
    $$('.phone').forEach(p => p.classList.remove('lit'));
    if (S.rec.active) setRec(false);
  }
  if (fresh || (was && !S.ready) || S.page === 'all') onPageShown();
}

/* ================================================================ device names */
/* ชื่อที่ผู้ใช้ตั้ง (ผูกกับ serial ตัวเครื่อง) > ชื่อในเครื่อง > รุ่น */
function devName(d) {
  if (!d) return 'มือถือ Android';
  return d.alias || S.briefs[d.serial]?.name || d.model || 'มือถือ Android';
}
async function renameDevice(serial) {
  const d = S.devices.find(x => x.serial === serial);
  if (!d) return;
  const name = await promptBox({
    title: 'ตั้งชื่อมือถือ', body: `จำชื่อนี้ไว้กับเครื่อง ${d.hw || d.serial} ถอดแล้วเสียบใหม่ก็ยังใช้ชื่อเดิม เว้นว่างเพื่อใช้ชื่อเดิมของเครื่อง`,
    value: d.alias || '', placeholder: S.briefs[serial]?.name || d.model || 'เช่น มือถือร้าน 1', ok: 'บันทึก', allowEmpty: true,
  });
  if (name === null) return;
  try {
    const st = await call('device_rename', serial, name);
    S.settings = st.settings;
    applyDevices(st);
    toast(name ? `ตั้งชื่อ "${name}" แล้ว` : 'ใช้ชื่อเดิมของเครื่องแล้ว', 'ok');
  } catch { /* แจ้งแล้ว */ }
}

/* ================================================================ all devices */
function tileState(d) {
  if (d.state === 'device') return '';
  if (d.state === 'unauthorized') return 'กด "อนุญาต" บนมือถือเครื่องนี้';
  if (d.state === 'offline') return 'ขาดการเชื่อมต่อ ลองถอดแล้วเสียบใหม่';
  return d.state;
}
function renderTiles() {
  const grid = $('#device-grid');
  const ready = S.devices.filter(d => d.state === 'device').length;
  const waiting = S.devices.length - ready;
  $('#all-count').innerHTML = S.devices.length
    ? `<b>${ready}</b>เครื่องพร้อมใช้งาน${waiting ? `  รออนุญาตหรือขาดการเชื่อมต่อ ${waiting} เครื่อง` : ''}`
    : '';
  $$('#page-all .all-bar .btn').forEach(b => { b.disabled = !ready; });
  const allOn = ready > 0 && S.devices.filter(d => d.state === 'device').every(d => S.mirrors.has(d.serial));
  $('#mirror-all').innerHTML = `${icon(allOn ? 'stop' : 'play')}<span>${allOn ? 'ปิดจอสดทั้งหมด' : 'เปิดจอสดทุกเครื่อง'}</span>`;
  $('#mirror-all').classList.toggle('live', allOn);
  if (!S.devices.length) {
    grid.innerHTML = `<div class="all-empty connect" style="grid-column:1/-1">${connectHTML()}</div>`;
    return;
  }
  grid.querySelector('.all-empty')?.remove();
  const seen = new Set();
  for (const d of S.devices) {
    seen.add(d.serial);
    let t = grid.querySelector(`.tile[data-serial="${CSS.escape(d.serial)}"]`);
    if (!t) {
      t = document.createElement('article');
      t.className = 'tile'; t.dataset.serial = d.serial;
      t.innerHTML = `<div class="phone mini" data-t="manage" title="จัดการเครื่องนี้"><div class="phone-screen"><img alt=""><span class="phone-empty"></span></div></div>
        <div class="tile-body"><h3></h3><p class="tile-sub"></p>
        <div class="tile-actions">
          <button class="btn" data-t="mirror"></button>
          <button class="icon-btn sm" data-t="rename" title="ตั้งชื่อเครื่องนี้">${icon('edit', 'sm')}</button>
          <button class="icon-btn sm" data-t="shot" title="แคปหน้าจอเครื่องนี้">${icon('camera', 'sm')}</button>
          <button class="icon-btn sm" data-t="manage" title="จัดการเครื่องนี้">${icon('chev-right', 'sm')}</button>
        </div></div>`;
      grid.append(t);
    }
    const ok = d.state === 'device', b = S.briefs[d.serial] || {};
    t.classList.toggle('current', d.serial === S.current);
    t.classList.toggle('waiting', !ok);
    t.querySelector('.phone').classList.toggle('lit', ok);
    if (!ok) t.querySelector('img').removeAttribute('src');
    t.querySelector('.phone-empty').textContent = ok ? 'กำลังโหลดภาพหน้าจอ' : tileState(d);
    t.querySelector('h3').textContent = devName(d);
    const bat = b.battery != null ? `แบต ${b.battery}%${b.charging ? ' กำลังชาร์จ' : ''}` : '';
    t.querySelector('.tile-sub').innerHTML = `<span class="status-dot ${ok ? 'ok' : d.state === 'unauthorized' ? 'wait' : 'bad'}"></span>`
      + `<span>${d.transport === 'wifi' ? 'Wi‑Fi' : 'USB'}</span>${bat ? `<span>${esc(bat)}</span>` : ''}`
      + (d.serial === S.current ? '<span class="here">กำลังจัดการ</span>' : '');
    const on = S.mirrors.has(d.serial);
    const mb = t.querySelector('[data-t="mirror"]');
    mb.disabled = !ok;
    mb.classList.toggle('live', on);
    mb.innerHTML = `${icon(on ? 'stop' : 'play', 'sm')}<span>${on ? 'ปิดจอสด' : 'เปิดจอสด'}</span>`;
    t.querySelector('[data-t="shot"]').disabled = !ok;
  }
  $$('#device-grid .tile').forEach(t => { if (!seen.has(t.dataset.serial)) t.remove(); });
}
async function grabAll() {
  const ready = S.devices.filter(d => d.state === 'device');
  for (const d of ready) {
    if (S.page !== 'all') return;
    const b = S.briefs[d.serial];
    if (!b || Date.now() - b.at > 30000) {
      const nb = await quiet('device_brief', d.serial);
      if (nb) { S.briefs[d.serial] = { ...nb, at: Date.now() }; renderTiles(); renderSwitch(); }
    }
    const f = await quiet('screen_frame', 720, d.serial);
    const t = $(`#device-grid .tile[data-serial="${CSS.escape(d.serial)}"]`);
    if (f && t) { t.querySelector('img').src = f.img; t.querySelector('.phone').style.setProperty('--ar', `${f.w} / ${f.h}`); }
  }
}
function bindAll() {
  $('#device-grid').addEventListener('click', async e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    const serial = b.closest('.tile').dataset.serial;
    const d = S.devices.find(x => x.serial === serial);
    const name = devName(d);
    try {
      if (b.dataset.t === 'rename') { renameDevice(serial); return; }
      if (b.dataset.t === 'mirror') {
        if (S.mirrors.has(serial)) await call('mirror_stop', serial);
        else await call('mirror_start', serial, null);
      } else if (b.dataset.t === 'shot') {
        const p = await call('screenshot', serial);
        toast(`แคปหน้าจอ ${name} แล้ว`, 'ok', { action: { label: 'เปิดดู', fn: () => quiet('open_path', p) } });
      } else if (b.dataset.t === 'manage') {
        if (d?.state !== 'device') { toast(tileState(d), 'warn'); return; }
        if (serial !== S.current) applyDevices(await call('select_device', serial));
        go('screen');
      }
    } catch { /* แจ้งแล้ว */ }
  });
  $$('[data-all]').forEach(b => b.onclick = async () => {
    try {
      const n = await call('broadcast_key', b.dataset.all);
      toast(`ส่งคำสั่งไป ${n} เครื่องแล้ว`, 'ok');
      loop.restart(500);
    } catch { /* แจ้งแล้ว */ }
  });
  $('#shot-all').onclick = async () => {
    try {
      const r = await call('screenshot_all');
      toast(`แคปหน้าจอ ${r.count} เครื่องแล้ว`, 'ok', { action: { label: 'เปิดโฟลเดอร์', fn: () => quiet('reveal_path', r.last) } });
    } catch { /* แจ้งแล้ว */ }
  };
  $('#mirror-all').onclick = async () => {
    const readyDevs = S.devices.filter(d => d.state === 'device');
    const allOn = readyDevs.length && readyDevs.every(d => S.mirrors.has(d.serial));
    try {
      if (allOn) await call('mirror_stop_all');
      else { const n = await call('mirror_start_all'); if (n) toast(`เปิดจอสด ${n} เครื่อง เรียงหน้าต่างให้แล้ว`, 'ok'); }
    } catch { /* แจ้งแล้ว */ }
  };
}
function renderSwitch() {
  const d = S.devices.find(x => x.serial === S.current);
  const dot = $('#status-dot');
  dot.className = 'status-dot ' + (!d ? '' : d.state === 'device' ? 'ok' : d.state === 'unauthorized' ? 'wait' : 'bad');
  $('#ds-name').textContent = d ? devName(d) : 'ยังไม่ได้เชื่อมต่อ';
  $('#ds-sub').textContent = deviceSub(d) + (S.devices.length > 1 ? ` (มี ${S.devices.length} เครื่อง)` : '');
}
function renderDeviceMenu() {
  const menu = $('#device-menu');
  const rows = S.devices.map(d => `<button data-serial="${esc(d.serial)}">${icon(d.transport === 'wifi' ? 'wifi' : 'usb')}
      <span><span>${esc(devName(d))}</span><small>${esc(deviceSub(d))}</small></span>
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

/* ================================================================ screen loop (มีลูปเดียวเสมอ) */
const loop = {
  token: 0,
  restart(delay = 0) {
    const t = ++this.token;
    const run = async () => {
      if (t !== this.token) return;
      let next = null;
      if (S.page === 'all' && document.visibilityState === 'visible' && S.devices.some(d => d.state === 'device')) {
        await grabAll();
        next = 3000;
      } else if (S.ready && document.visibilityState === 'visible') {
        if (S.page === 'screen' && S.rate > 0) {
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
/* จอสดเปิดได้หลายเครื่องพร้อมกัน ปุ่มบนแถบด้านบนสะท้อนสถานะของเครื่องที่กำลังจัดการ */
/* คำอธิบายของแต่ละวิธีส่งการควบคุม: ใช้ทั้งในหน้าตั้งค่าและข้อความตอนเปิดจอสด */
const INPUT_HINTS = {
  normal: 'เมาส์และคีย์บอร์ดแบบปกติ ใช้ได้เกือบทุกหน้า และใช้ผ่านโปรแกรมรีโมตได้',
  physical: 'สำหรับหน้าที่แตะไม่ได้ เช่น หน้าสมัคร WhatsApp เมาส์จะถูกจับไว้ในหน้าต่างจอสด กด Alt หรือปุ่ม Windows เพื่อปล่อยเมาส์กลับมาที่คอม ใช้ผ่านโปรแกรมรีโมตไม่ได้ Android 11 ขึ้นไป',
  remote: 'ใช้เมื่อควบคุมคอมผ่าน UltraViewer, TeamViewer หรือ AnyDesk ไปที่หน้า "หน้าจอ" แล้วคลิกที่ภาพมือถือเพื่อแตะแบบสัมผัสจริง ใช้ได้กับหน้าที่แตะไม่ได้ เช่น หน้าสมัคร WhatsApp และพิมพ์ด้วยคีย์บอร์ดของคอมได้เลย · Android 11 ขึ้นไป',
};
const INPUT_TOASTS = {
  physical: 'โหมดอุปกรณ์จริง: เมาส์ถูกจับไว้ควบคุมมือถือ กด Alt หรือปุ่ม Windows เพื่อปล่อยเมาส์กลับมาที่คอม',
};
let inputHintShown = false;
function setMirrors(list) {
  const prev = S.mirrors;
  S.mirrors = new Set(list || []);
  // เพิ่งเปิดจอสดเครื่องใหม่ในโหมดที่ใช้อุปกรณ์จริง: บอกวิธีใช้ (ครั้งเดียวต่อการเปิดโปรแกรม)
  const hint = S.inited && INPUT_TOASTS[S.settings.input_mode];
  if (hint && !inputHintShown && [...S.mirrors].some(s => !prev.has(s))) {
    inputHintShown = true;
    toast(hint, 'ok', { ms: 11000 });
  }
  const on = S.mirrors.has(S.current);
  const label = on ? 'ปิดจอสด' : 'เปิดจอสด', ic = on ? 'stop' : 'play';
  $$('#mirror-btn, [data-act="mirror"]').forEach(b => {
    b.classList.toggle('live', on);
    b.innerHTML = `${icon(ic)}<span>${label}</span>`;
  });
  if (S.inited) renderTiles();
}
async function toggleMirror(forceOn) {
  const on = S.mirrors.has(S.current);
  try {
    if (on && forceOn !== true) await call('mirror_stop');
    else if (!on) await call('mirror_start');
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

/* ================================================================ schedule */
const DAY_NAMES = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา'];
const ACTION_NAMES = { wake: 'ปลุกจอ', mirror: 'เปิดจอสด', sleep: 'ปิดจอ', mirror_off: 'ปิดจอสด' };
const ACTION_ICONS = { wake: 'power', mirror: 'play', sleep: 'power', mirror_off: 'stop' };
function daysText(days) {
  const s = [...days].sort((a, b) => a - b).join(',');
  if (s === '0,1,2,3,4,5,6') return 'ทุกวัน';
  if (s === '0,1,2,3,4') return 'จันทร์ถึงศุกร์';
  if (s === '5,6') return 'เสาร์ อาทิตย์';
  return days.map(d => DAY_NAMES[d]).join(' ');
}
/* เครื่องที่เลือกได้: เครื่องที่เคยตั้งชื่อไว้ และเครื่องที่เสียบอยู่ตอนนี้ */
function knownTargets() {
  const map = new Map();
  for (const [hw, name] of Object.entries(S.settings.device_names || {})) map.set(hw, { hw, name, connected: false });
  for (const d of S.devices) {
    const hw = d.hw || d.serial;
    map.set(hw, { hw, name: devName(d), connected: d.state === 'device' });
  }
  return [...map.values()];
}
function targetText(target) {
  if (target === 'all') return 'ทุกเครื่องที่เชื่อมต่อ';
  return knownTargets().find(x => x.hw === target)?.name || `เครื่อง ${target}`;
}
function renderSchedules() {
  const list = S.settings.schedules || [];
  const el = $('#sched-list');
  if (!list.length) {
    el.innerHTML = '<div class="empty"><b>ยังไม่มีการตั้งเวลา</b>กด "เพิ่มเวลา" เพื่อให้มือถือปลุกจอหรือเปิดจอสดเองตามเวลาที่ตั้งไว้</div>';
    return;
  }
  el.innerHTML = list.map(s => `<div class="sched-row ${s.enabled ? '' : 'off'}" data-id="${esc(s.id)}">
      <span class="sched-time">${esc(s.time)}</span>
      <div class="sched-meta"><b>${icon(ACTION_ICONS[s.action], 'sm')}${ACTION_NAMES[s.action]}</b>
        <small>${esc(daysText(s.days))}<span class="sep"></span>${esc(targetText(s.target))}</small></div>
      <div class="sched-actions">
        <button class="btn ghost sm" data-s="run">ลองตอนนี้</button>
        <button class="icon-btn sm" data-s="edit" title="แก้ไข">${icon('edit', 'sm')}</button>
        <button class="icon-btn sm" data-s="del" title="ลบ">${icon('trash', 'sm')}</button>
        <span class="switch" title="${s.enabled ? 'เปิดใช้อยู่' : 'ปิดไว้'}"><input type="checkbox" data-s="toggle" ${s.enabled ? 'checked' : ''} aria-label="เปิดใช้เวลานี้"><i></i></span>
      </div></div>`).join('');
}
function editSchedule(item) {
  const s = item ? { ...item, days: [...item.days] } : { time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], action: 'wake', target: 'all', enabled: true };
  const targets = knownTargets();
  const unknown = s.target !== 'all' && !targets.some(x => x.hw === s.target);
  return dialog(() => {
    const m = modal(`<h3>${item ? 'แก้ไขเวลา' : 'เพิ่มเวลา'}</h3>
      <div class="form">
        <label class="f-label" for="sf-time">เวลา</label>
        <input class="input time" type="time" id="sf-time" value="${esc(s.time)}">
        <span class="f-label">วัน</span>
        <div class="day-chips" id="sf-days">${DAY_NAMES.map((n, i) => `<button type="button" class="day ${s.days.includes(i) ? 'on' : ''}" data-d="${i}" aria-pressed="${s.days.includes(i)}">${n}</button>`).join('')}</div>
        <div class="day-quick"><button type="button" class="chip" data-q="0,1,2,3,4,5,6">ทุกวัน</button><button type="button" class="chip" data-q="0,1,2,3,4">จันทร์ถึงศุกร์</button><button type="button" class="chip" data-q="5,6">เสาร์ อาทิตย์</button></div>
        <span class="f-label">ให้ทำอะไร</span>
        <div class="seg" id="sf-action">${Object.entries(ACTION_NAMES).map(([k, v]) => `<button type="button" data-a="${k}" class="${s.action === k ? 'on' : ''}">${v}</button>`).join('')}</div>
        <label class="f-label" for="sf-target">กับเครื่องไหน</label>
        <select class="input" id="sf-target"><option value="all">ทุกเครื่องที่เชื่อมต่อ</option>
          ${targets.map(x => `<option value="${esc(x.hw)}" ${s.target === x.hw ? 'selected' : ''}>${esc(x.name)}${x.connected ? '' : ' (ไม่ได้เชื่อมต่อตอนนี้)'}</option>`).join('')}
          ${unknown ? `<option value="${esc(s.target)}" selected>เครื่อง ${esc(s.target)}</option>` : ''}</select>
      </div>
      <p class="form-err" id="sf-err"></p>
      <div class="modal-actions"><button class="btn ghost" data-r="0">ยกเลิก</button><button class="btn primary" data-r="1">บันทึก</button></div>`);
    const paintDays = () => $$('#sf-days .day', m).forEach(b => {
      const on = s.days.includes(+b.dataset.d);
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    });
    m.querySelector('#sf-days').onclick = e => {
      const b = e.target.closest('[data-d]'); if (!b) return;
      const d = +b.dataset.d;
      s.days = s.days.includes(d) ? s.days.filter(x => x !== d) : [...s.days, d];
      paintDays();
    };
    m.querySelector('.day-quick').onclick = e => {
      const b = e.target.closest('[data-q]'); if (!b) return;
      s.days = b.dataset.q.split(',').map(Number); paintDays();
    };
    m.querySelector('#sf-action').onclick = e => {
      const b = e.target.closest('[data-a]'); if (!b) return;
      s.action = b.dataset.a;
      $$('#sf-action button', m).forEach(x => x.classList.toggle('on', x === b));
    };
    m.querySelector('[data-r="0"]').onclick = () => m._done(null);
    m.querySelector('[data-r="1"]').onclick = async () => {
      s.time = m.querySelector('#sf-time').value;
      s.target = m.querySelector('#sf-target').value;
      try {
        S.settings.schedules = await api.schedule_save(s);
        m._done(true);
        renderSchedules();
        toast(`ตั้งเวลา ${s.time} ${ACTION_NAMES[s.action]} แล้ว`, 'ok');
      } catch (e) { m.querySelector('#sf-err').textContent = errText(e); }
    };
    return m;
  }, '#sf-time');
}
function bindSchedule() {
  $('#sched-add').onclick = () => editSchedule(null);
  const list = $('#sched-list');
  list.addEventListener('click', async e => {
    const b = e.target.closest('[data-s]'); if (!b || b.dataset.s === 'toggle') return;
    const id = b.closest('.sched-row').dataset.id;
    const s = (S.settings.schedules || []).find(x => x.id === id); if (!s) return;
    try {
      if (b.dataset.s === 'edit') editSchedule(s);
      else if (b.dataset.s === 'run') { b.disabled = true; await call('schedule_run', id); }
      else if (b.dataset.s === 'del') {
        if (!await confirmBox({ title: `ลบเวลา ${s.time}`, body: `${ACTION_NAMES[s.action]} ${daysText(s.days)}`, ok: 'ลบ', danger: true })) return;
        S.settings.schedules = await call('schedule_delete', id);
        renderSchedules();
      }
    } catch { /* แจ้งแล้ว */ } finally { b.disabled = false; }
  });
  list.addEventListener('change', async e => {
    const i = e.target.closest('[data-s="toggle"]'); if (!i) return;
    const id = i.closest('.sched-row').dataset.id;
    const s = (S.settings.schedules || []).find(x => x.id === id); if (!s) return;
    try { S.settings.schedules = await call('schedule_save', { ...s, enabled: i.checked }); renderSchedules(); }
    catch { i.checked = !i.checked; }
  });
}

/* ================================================================ settings */
function renderSettings() {
  const st = S.settings;
  $$('[data-set]').forEach(i => { i.checked = !!st[i.dataset.set]; });
  $$('#quality-seg button').forEach(b => b.classList.toggle('on', b.dataset.q === st.quality));
  $$('#input-seg button').forEach(b => {
    const on = b.dataset.im === st.input_mode;
    b.classList.toggle('on', on); b.setAttribute('aria-checked', on); b.setAttribute('role', 'radio');
  });
  $('#input-hint').textContent = INPUT_HINTS[st.input_mode] || '';
  $('#save-dir').textContent = st.save_dir;
  $('#about-version').textContent = `เวอร์ชัน ${S.version}`;
}
function bindSettings() {
  $$('[data-set]').forEach(i => i.onchange = async () => {
    try { S.settings = await call('settings_set', i.dataset.set, i.checked); } catch { i.checked = !i.checked; }
  });
  $('#input-seg').addEventListener('click', async e => {
    const b = e.target.closest('[data-im]'); if (!b || b.dataset.im === S.settings.input_mode) return;
    try { S.settings = await call('settings_set', 'input_mode', b.dataset.im); renderSettings(); updateViewerHint(); } catch { return; }
    inputHintShown = false;
    if (b.dataset.im === 'remote') toast('ไปที่หน้า "หน้าจอ" แล้วคลิกที่ภาพมือถือเพื่อแตะแบบสัมผัสจริง ใช้ได้แม้ควบคุมผ่านรีโมต', 'ok', { ms: 10000 });
    if (S.mirrors.size) toast('จะใช้วิธีใหม่ตอนเปิดจอสดครั้งถัดไป ปิดแล้วเปิดจอสดใหม่ได้เลย', 'info');
  });
  $('#quality-seg').addEventListener('click', async e => {
    const b = e.target.closest('[data-q]'); if (!b) return;
    try { S.settings = await call('settings_set', 'quality', b.dataset.q); renderSettings(); } catch { /* แจ้งแล้ว */ }
    if (S.mirrors.size) toast('คุณภาพใหม่จะใช้ตอนเปิดจอสดครั้งถัดไป', 'info');
  });
  $('#save-dir-open').onclick = () => call('open_save_dir', '').catch(() => {});
  $('#save-dir-change').onclick = async () => { try { S.settings = await call('pick_save_dir'); renderSettings(); } catch { /* แจ้งแล้ว */ } };
  $('#check-update').onclick = () => checkUpdate(false);
  $('#update-open').onclick = showUpdate;
  $('#open-github').onclick = () => quiet('open_url_pc', `https://github.com/${S.repo}`);
}
/* ---------- update */
let updateShown = false;
async function checkUpdate(silent) {
  const btn = $('#check-update');
  if (!silent) { btn.disabled = true; }
  const r = silent ? await quiet('check_update') : await call('check_update').catch(() => null);
  btn.disabled = false;
  if (!r) return;
  S.update = r;
  renderUpdateBadges();
  if (r.newer) {
    if (!silent || (!r.skipped && !updateShown)) { updateShown = true; showUpdate(); }
  } else if (!silent) toast(`ใช้เวอร์ชันล่าสุดอยู่แล้ว (${r.current})`, 'ok');
}
function renderUpdateBadges() {
  const u = S.update, on = !!(u && u.newer);
  $('.rail-btn[data-page="settings"]').classList.toggle('has-update', on);
  $('#update-row').hidden = !on;
  if (on) {
    $('#update-title').textContent = `เวอร์ชัน ${u.latest} พร้อมให้อัปเดต`;
    $('#update-sub').textContent = u.can_auto ? 'ติดตั้งได้ในคลิกเดียว โปรแกรมจะเปิดใหม่เอง' : 'ดาวน์โหลดตัวติดตั้งจากหน้า GitHub';
  }
}
function notesHTML(text) {
  const lines = (text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 14);
  if (!lines.length) return '';
  const items = lines.map(l => l.replace(/^[-*•]\s*/, '').replace(/\*\*/g, ''));
  return `<ul class="notes">${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>`;
}
function showUpdate() {
  const u = S.update; if (!u || !u.newer) return;
  const m = modal(`<div class="update-head"><img src="logo.png" alt=""><div>
      <h3>GiGoGi ${esc(u.latest)} พร้อมให้อัปเดต</h3>
      <p>ตอนนี้ใช้เวอร์ชัน ${esc(u.current)}${u.size ? `  ขนาด ${fmtBytes(u.size)}` : ''}</p></div></div>
    ${u.notes ? `<h4 class="notes-title">มีอะไรใหม่</h4>${notesHTML(u.notes)}` : ''}
    <div class="update-progress" hidden><div class="bar"><i></i></div><p class="up-text"></p></div>
    <div class="modal-actions">
      <button class="btn ghost" data-u="skip">ข้ามเวอร์ชันนี้</button>
      <span class="spacer"></span>
      <button class="btn ghost" data-u="later">ภายหลัง</button>
      ${u.can_auto ? '<button class="btn primary" data-u="install">อัปเดตเลย</button>' : '<button class="btn primary" data-u="page">ดาวน์โหลดจาก GitHub</button>'}
    </div>`, true);
  m.classList.add('update');
  let busy = false;
  const close = () => { if (!busy) { document.removeEventListener('keydown', onKey, true); closeModal(); } };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  $('#modal')._close = close;
  m.querySelector('[data-u="later"]').onclick = close;
  m.querySelector('[data-u="skip"]').onclick = () => { quiet('update_skip', u.latest); u.skipped = true; close(); toast(`จะไม่เตือนเวอร์ชัน ${u.latest} อีก ตรวจเองได้ในหน้าตั้งค่า`, 'info'); };
  const page = m.querySelector('[data-u="page"]');
  if (page) page.onclick = () => { quiet('open_url_pc', u.url); close(); };
  const inst = m.querySelector('[data-u="install"]');
  if (inst) inst.onclick = async () => {
    busy = true;
    m.querySelectorAll('[data-u]').forEach(b => { b.disabled = true; });
    m.querySelector('.update-progress').hidden = false;
    setUpdateProgress({ phase: 'download', done: 0, total: u.size || 0 });
    try {
      const r = await api.update_install();
      if (r && r.dryrun) { busy = false; close(); toast('ทดสอบดาวน์โหลดสำเร็จ (ไม่ได้ติดตั้งจริง)', 'ok'); }
    } catch (e) {
      busy = false;
      m.querySelectorAll('[data-u]').forEach(b => { b.disabled = false; });
      m.querySelector('.up-text').textContent = errText(e);
      m.querySelector('.update-progress').classList.add('error');
    }
  };
  (inst || page).focus();
}
function setUpdateProgress(p) {
  const box = $('#modal .update-progress'); if (!box) return;
  box.classList.remove('error');
  const pct = p.total ? p.done / p.total : 0;
  box.querySelector('.bar i').style.width = (p.phase === 'install' ? 100 : pct * 100) + '%';
  box.querySelector('.up-text').textContent = p.phase === 'install'
    ? 'กำลังติดตั้ง โปรแกรมจะปิดแล้วเปิดขึ้นมาใหม่เองในไม่กี่วินาที'
    : `กำลังดาวน์โหลด ${fmtBytes(p.done)}${p.total ? ` จาก ${fmtBytes(p.total)}` : ''}`;
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
    else if (ev === 'mirror') { setMirrors(data.mirrors); if (data.error) toast(data.error, 'error'); }
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
    else if (ev === 'update') setUpdateProgress(data);
    else if (ev === 'schedule') toast(data.msg, data.ok ? 'ok' : 'warn', { ms: 8000 });
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
    if (e.ctrlKey && /^[1-7]$/.test(e.key)) { e.preventDefault(); go(Object.keys(TITLES)[+e.key - 1]); }
  });
  document.addEventListener('visibilitychange', () => loop.restart());
}

async function init(apiObj) {
  if (S.inited) return;
  api = apiObj;
  bindShell(); bindViewer(); bindFiles(); bindApps(); bindTools(); bindSettings(); bindDrop(); bindAll(); bindSchedule();
  const st = await api.get_state();
  S.tools = st.tools; S.settings = st.settings; S.version = st.version; S.repo = st.repo; S.logs = st.logs || [];
  renderSettings(); renderLog(); renderPlaces(); renderAppDetail(null);
  setMirrors(st.mirrors);
  setRec(st.recording.active, Date.now() - st.recording.elapsed * 1000);
  setRate(S.rate);
  S.inited = true;
  applyDevices(st);
  go('all');
  pending.splice(0).forEach(([ev, data]) => window.GG.onEvent(ev, data));
  if (!st.tools.scrcpy) toast('ไม่พบ scrcpy ปุ่มจอสดจะใช้ไม่ได้ ติดตั้งโปรแกรมใหม่ด้วยตัวติดตั้ง', 'warn', { sticky: true });
  if (st.settings.check_updates) {
    setTimeout(() => checkUpdate(true), 2500);
    setInterval(() => { if (S.settings.check_updates) checkUpdate(true); }, 6 * 3600 * 1000);
  }
}

window.addEventListener('pywebviewready', () => init(window.pywebview.api));
if (window.pywebview?.api?.get_state) init(window.pywebview.api);
if (/[?&]demo/.test(location.search)) {
  const s = document.createElement('script'); s.src = 'demo.js'; document.head.append(s);
}
