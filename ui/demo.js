'use strict';
/* โหมดสาธิต (เปิด index.html?demo) — ใช้ตรวจหน้าตาโดยไม่ต้องมีมือถือ ไม่ถูกโหลดในโปรแกรมจริง
   ?demo=none        ยังไม่เสียบมือถือ
   ?demo=unauthorized รอกดอนุญาต */
(() => {
  const mode = new URLSearchParams(location.search).get('demo') || 'ready';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const dev = { serial: 'R5CW31ABCDE', state: 'device', model: 'SM S918B', transport: 'usb' };

  const multi = mode === 'multi';
  const others = [
    { serial: '9A231FFAZ00K', state: 'device', model: 'Pixel 8', transport: 'usb' },
    { serial: '192.168.1.52:5555', state: 'device', model: 'Redmi Note 13', transport: 'wifi' },
    { serial: 'HT7A1B2C3D', state: 'unauthorized', model: '', transport: 'usb' },
  ];
  const briefs = { R5CW31ABCDE: ['Galaxy S23 Ultra', 82, true], '9A231FFAZ00K': ['Pixel 8', 64, false], '192.168.1.52:5555': ['Redmi Note 13', 23, false] };
  const mirrors = new Set();
  const settings = {
    quality: 'balanced', stay_awake: true, screen_off: false, audio: true, on_top: false, show_touches: false, record_mirror: false,
    physical_input: false, auto_mirror: false, close_mirror_on_exit: true, check_updates: /update/.test(location.search),
    start_with_windows: false, skip_version: '', save_dir: 'C:\\Users\\User\\Documents\\GiGoGi',
    device_names: { '9A231FFAZ00K': 'มือถือหน้าร้าน', OLD123456: 'เครื่องสำรอง' },
    schedules: [
      { id: 'a1b2c3d4', time: '08:00', days: [0, 1, 2, 3, 4], action: 'wake', target: 'all', enabled: true },
      { id: 'b2c3d4e5', time: '08:05', days: [0, 1, 2, 3, 4], action: 'mirror', target: '9A231FFAZ00K', enabled: true },
      { id: 'c3d4e5f6', time: '22:30', days: [0, 1, 2, 3, 4, 5, 6], action: 'sleep', target: 'all', enabled: false },
    ],
  };
  const withNames = list => list.map(d => ({ ...d, hw: d.serial.includes(':') ? 'RDMNOTE13X' : d.serial, alias: settings.device_names[d.serial.includes(':') ? 'RDMNOTE13X' : d.serial] || '' }));

  function frame(stops = ['#16324a', '#1d1b3a', '#3a1830']) {
    const c = document.createElement('canvas'); c.width = 540; c.height = 1170;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 540, 1170);
    bg.addColorStop(0, stops[0]); bg.addColorStop(.55, stops[1]); bg.addColorStop(1, stops[2]);
    g.fillStyle = bg; g.fillRect(0, 0, 540, 1170);
    g.fillStyle = '#fff'; g.font = '600 26px Segoe UI'; g.fillText('14:32', 34, 52);
    g.font = '300 120px Segoe UI'; g.fillText('14:32', 120, 330);
    g.font = '400 30px Segoe UI'; g.fillStyle = 'rgba(255,255,255,.8)'; g.fillText('พฤหัสบดี 27 พฤศจิกายน', 120, 380);
    const cols = ['#4285f4', '#34a853', '#fbbc05', '#ea4335', '#06c755', '#1877f2', '#ff0050', '#9c27b0'];
    cols.forEach((col, i) => {
      const x = 58 + (i % 4) * 116, y = 820 + Math.floor(i / 4) * 140;
      g.fillStyle = col; g.beginPath(); g.roundRect(x, y, 84, 84, 24); g.fill();
    });
    g.fillStyle = 'rgba(255,255,255,.18)'; g.beginPath(); g.roundRect(40, 1080, 460, 56, 28); g.fill();
    return c.toDataURL('image/jpeg', .8);
  }
  const shot = frame();
  const shots = { '9A231FFAZ00K': frame(['#13322a', '#0f2a1f', '#2b3a12']), '192.168.1.52:5555': frame(['#3a2a12', '#2a1a10', '#40141c']) };
  const files = {
    '/sdcard': [['Alarms', 'dir'], ['Android', 'dir'], ['DCIM', 'dir'], ['Documents', 'dir'], ['Download', 'dir'], ['Movies', 'dir'], ['Music', 'dir'], ['Pictures', 'dir'],
      ['ใบเสร็จ ค่าไฟ ตุลาคม.pdf', 'file', 248113], ['notes.txt', 'file', 1820]],
    '/sdcard/DCIM': [['Camera', 'dir'], ['Screenshots', 'dir']],
    '/sdcard/DCIM/Camera': Array.from({ length: 14 }, (_, i) => [`IMG_20261120_${String(101532 + i * 37)}.jpg`, 'file', 2400000 + i * 91233]).concat([['VID_20261121_183012.mp4', 'file', 48213000]]),
    '/sdcard/Download': [['line-14.18.0.apk', 'file', 98211000], ['สัญญาเช่า.docx', 'file', 88213], ['playlist.m3u', 'file', 912]],
  };
  const apps = ['jp.naver.line.android', 'com.facebook.katana', 'com.kasikorn.retail.mbanking.wap', 'com.shopee.th', 'com.lazada.android', 'com.grabtaxi.passenger',
    'com.google.android.youtube', 'com.instagram.android', 'com.spotify.music', 'com.ktb.customer.qr', 'com.netflix.mediaclient', 'com.zhiliaoapp.musically'];

  const demo = {
    async get_state() {
      const ready = mode === 'ready' || multi;
      return {
        version: '2.0.0', repo: 'shadow-artlap/GiGoGi', tools: { adb: true, scrcpy: true },
        settings,
        logs: [{ t: '14:30:02', msg: 'พบ SM S918B', level: 'ok' }, { t: '14:31:10', msg: 'บันทึกภาพหน้าจอแล้ว: screen_20261127_143110.png', level: 'ok' }],
        mirror: false, recording: { active: false, elapsed: 0 },
        devices: mode === 'none' ? [] : withNames([{ ...dev, state: ready || multi ? 'device' : 'unauthorized', model: ready || multi ? dev.model : '' }].concat(multi ? others : [])),
        mirrors: [],
        current: mode === 'none' ? null : dev.serial, state: mode === 'none' ? null : ready ? 'device' : 'unauthorized', ready,
      };
    },
    async device_info() {
      await wait(300);
      return { name: 'Galaxy S23 Ultra', brand: 'Samsung', model: 'SM-S918B', android: '14', sdk: '34', serial: dev.serial, battery: 82, charging: true, full: false,
        power_source: 'USB', temp: 31.4, storage_total: 256e9 * 0.93, storage_used: 141e9, mem_total: 11.2e9, mem_avail: 4.6e9,
        screen: '1080 × 2340', density: '450', ip: '192.168.1.44', uptime: 302400 };
    },
    async screen_frame(max, serial) { await wait(120); return { img: shots[serial] || shot, w: 1080, h: 2340 }; },
    async device_brief(serial) { await wait(100); const b = briefs[serial] || ['Android', 50, false]; return { serial, name: b[0], battery: b[1], charging: b[2] }; },
    async mirror_start(serial) { mirrors.add(serial || dev.serial); GG.onEvent('mirror', { mirrors: [...mirrors] }); return true; },
    async mirror_stop(serial) { mirrors.delete(serial || dev.serial); GG.onEvent('mirror', { mirrors: [...mirrors] }); return false; },
    async mirror_start_all() { [dev.serial, ...others.filter(o => o.state === 'device').map(o => o.serial)].forEach(s => mirrors.add(s)); GG.onEvent('mirror', { mirrors: [...mirrors] }); return 3; },
    async mirror_stop_all() { mirrors.clear(); GG.onEvent('mirror', { mirrors: [] }); },
    async broadcast_key() { await wait(200); return 3; },
    async device_rename(serial, name) {
      const all = [dev, ...others];
      const d = all.find(x => x.serial === serial); const hw = withNames([d])[0].hw;
      if (name) settings.device_names[hw] = name; else delete settings.device_names[hw];
      const st = await demo.get_state();
      return { ...st, settings };
    },
    async schedule_save(item) {
      if (!/^\d\d:\d\d$/.test(item.time)) throw new Error('เวลาต้องเป็นแบบ 07:30');
      if (!item.days.length) throw new Error('เลือกอย่างน้อย 1 วัน');
      const it = { ...item, id: item.id || Math.random().toString(16).slice(2, 10) };
      settings.schedules = settings.schedules.filter(s => s.id !== it.id).concat(it).sort((a, b) => a.time.localeCompare(b.time));
      return settings.schedules;
    },
    async schedule_delete(id) { settings.schedules = settings.schedules.filter(s => s.id !== id); return settings.schedules; },
    async schedule_run(id) { await wait(300); GG.onEvent('schedule', { id, ok: 2, msg: 'ตั้งเวลา: ทำแล้ว 2 เครื่อง' }); return 2; },
    async files_list(p) {
      await wait(150);
      const list = files[p] || [];
      return { path: p, items: list.map(([name, kind, size]) => ({ name, kind, size: size ?? null, date: kind === 'dir' ? '2026-10-02 09:14' : '2026-11-27 11:05' })) };
    },
    async apps_list() { await wait(200); return apps.sort().map(pkg => ({ pkg, disabled: false })); },
    async app_detail(pkg) {
      await wait(200);
      return { pkg, version: '14.18.0', code: '141800', installed: '2025-03-14 10:22:01', updated: '2026-11-20 08:01:44', installer: 'com.android.vending', system: false, disabled: false, size: 182000000, splits: 4 };
    },
    async check_update() {
      const newer = /update/.test(location.search);
      return { current: '2.0.0', latest: newer ? '2.1.0' : '2.0.0', newer, url: '', size: 24117248, can_auto: true, skipped: false,
        notes: '- แจ้งเตือนและติดตั้งอัปเดตได้ในโปรแกรม\n- ดาวน์โหลดพร้อมแถบความคืบหน้า แล้วเปิดโปรแกรมใหม่เอง\n- ข้ามเวอร์ชันที่ไม่ต้องการได้' };
    },
    async update_install() {
      for (let d = 0; d <= 24117248; d += 2400000) { GG.onEvent('update', { phase: 'download', done: d, total: 24117248 }); await wait(250); }
      GG.onEvent('update', { phase: 'install', done: 1, total: 1 }); await wait(1500);
      return { dryrun: true };
    },
  };
  const api = new Proxy(demo, { get: (t, k) => t[k] || (async () => { await wait(200); if (k === 'screenshot') return 'C:\\demo.png'; return true; }) });
  window.pywebview = { api };
  init(api);
})();
