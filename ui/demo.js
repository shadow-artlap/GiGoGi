'use strict';
/* โหมดสาธิต (เปิด index.html?demo) — ใช้ตรวจหน้าตาโดยไม่ต้องมีมือถือ ไม่ถูกโหลดในโปรแกรมจริง
   ?demo=none        ยังไม่เสียบมือถือ
   ?demo=unauthorized รอกดอนุญาต */
(() => {
  const mode = new URLSearchParams(location.search).get('demo') || 'ready';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const dev = { serial: 'R5CW31ABCDE', state: 'device', model: 'SM S918B', transport: 'usb' };

  function frame() {
    const c = document.createElement('canvas'); c.width = 540; c.height = 1170;
    const g = c.getContext('2d');
    const bg = g.createLinearGradient(0, 0, 540, 1170);
    bg.addColorStop(0, '#16324a'); bg.addColorStop(.55, '#1d1b3a'); bg.addColorStop(1, '#3a1830');
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
      const ready = mode === 'ready';
      return {
        version: '2.0.0', repo: 'shadow-artlap/GiGoGi', tools: { adb: true, scrcpy: true },
        settings: { quality: 'balanced', stay_awake: true, screen_off: false, audio: true, on_top: false, show_touches: false, record_mirror: false, auto_mirror: false, close_mirror_on_exit: true, check_updates: false, save_dir: 'C:\\Users\\User\\Documents\\GiGoGi' },
        logs: [{ t: '14:30:02', msg: 'พบ SM S918B', level: 'ok' }, { t: '14:31:10', msg: 'บันทึกภาพหน้าจอแล้ว: screen_20261127_143110.png', level: 'ok' }],
        mirror: false, recording: { active: false, elapsed: 0 },
        devices: mode === 'none' ? [] : [{ ...dev, state: ready ? 'device' : 'unauthorized', model: ready ? dev.model : '' }],
        current: mode === 'none' ? null : dev.serial, state: mode === 'none' ? null : ready ? 'device' : 'unauthorized', ready,
      };
    },
    async device_info() {
      await wait(300);
      return { name: 'Galaxy S23 Ultra', brand: 'Samsung', model: 'SM-S918B', android: '14', sdk: '34', serial: dev.serial, battery: 82, charging: true, full: false,
        power_source: 'USB', temp: 31.4, storage_total: 256e9 * 0.93, storage_used: 141e9, mem_total: 11.2e9, mem_avail: 4.6e9,
        screen: '1080 × 2340', density: '450', ip: '192.168.1.44', uptime: 302400 };
    },
    async screen_frame() { await wait(120); return { img: shot, w: 1080, h: 2340 }; },
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
    async check_update() { return { current: '2.0.0', latest: '2.0.0', newer: false, url: '' }; },
  };
  const api = new Proxy(demo, { get: (t, k) => t[k] || (async () => { await wait(200); if (k === 'screenshot') return 'C:\\demo.png'; return true; }) });
  window.pywebview = { api };
  init(api);
})();
