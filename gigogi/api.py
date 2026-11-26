# -*- coding: utf-8 -*-
"""API ที่หน้า UI (ui/app.js) เรียกผ่าน pywebview: window.pywebview.api.<method>()"""

import base64
import collections
import datetime
import io
import json
import os
import posixpath
import re
import subprocess
import threading
import time

from version import __version__, GITHUB_REPO
from .core import (APP_DIR, IS_WIN, NO_WINDOW, RES_DIR, Adb, AdbError, find_tool, friendly_error,
                   parse_devices, parse_kv, parse_ls, parse_wm_size, shq, version_tuple)

APP_TITLE = "GiGoGi"
CONF_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "GiGoGi")
CONF_FILE = os.path.join(CONF_DIR, "settings.json")
DEFAULT_SAVE_DIR = os.path.join(os.path.expanduser("~"), "Documents", "GiGoGi")
REMOTE_REC = "/data/local/tmp/gigogi_rec.mp4"
PKG_RE = re.compile(r"^[A-Za-z0-9_.]+$")
KEY_RE = re.compile(r"^(KEYCODE_[A-Z0-9_]+|\d{1,3})$")

DEFAULTS = {
    "quality": "balanced",       # saver | balanced | sharp
    "stay_awake": True,
    "screen_off": False,
    "audio": True,
    "on_top": False,
    "show_touches": False,
    "record_mirror": False,
    "auto_mirror": False,
    "close_mirror_on_exit": True,
    "check_updates": True,
    "skip_version": "",
    "save_dir": DEFAULT_SAVE_DIR,
}
QUALITY = {"saver": ("1024", "4M"), "balanced": ("1600", "8M"), "sharp": (None, "16M")}
UPDATE_URL_PREFIX = f"https://github.com/{GITHUB_REPO}/releases/download/"


def current_version():
    # GIGOGI_FAKE_VERSION ใช้ทดสอบระบบอัปเดตเท่านั้น
    return os.environ.get("GIGOGI_FAKE_VERSION") or __version__


def can_self_update():
    """อัปเดตเองได้เฉพาะเมื่อรันจาก .exe ที่ติดตั้งด้วยตัวติดตั้ง (มีตัวถอนการติดตั้งอยู่ข้าง ๆ)"""
    from .core import FROZEN
    if os.environ.get("GIGOGI_UPDATE_DRYRUN"):
        return True
    return IS_WIN and FROZEN and os.path.isfile(os.path.join(APP_DIR, "unins000.exe"))


def _load_settings():
    s = dict(DEFAULTS)
    try:
        with open(CONF_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        s.update({k: v for k, v in data.items() if k in DEFAULTS and type(v) is type(DEFAULTS[k])})
    except (OSError, ValueError):
        pass
    if s["quality"] not in QUALITY:
        s["quality"] = "balanced"
    return s


def _to_bytes(tok):
    """'1024' (KB) หรือ '3.2G' → bytes"""
    m = re.match(r"^([\d.]+)([KMGT]?)$", tok.strip(), re.I)
    if not m:
        return None
    n = float(m.group(1))
    unit = m.group(2).upper()
    if not unit:
        return int(n * 1024)
    return int(n * 1024 ** "KMGT".index(unit) * 1024)


def set_clipboard(text):
    """ตั้งค่าคลิปบอร์ด Windows (Unicode) ด้วย Win32 API"""
    if not IS_WIN:
        raise AdbError("รองรับเฉพาะ Windows")
    import ctypes
    from ctypes import wintypes
    u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
    k32.GlobalAlloc.restype = wintypes.HGLOBAL
    k32.GlobalAlloc.argtypes = (wintypes.UINT, ctypes.c_size_t)
    k32.GlobalLock.restype = wintypes.LPVOID
    k32.GlobalLock.argtypes = (wintypes.HGLOBAL,)
    k32.GlobalUnlock.argtypes = (wintypes.HGLOBAL,)
    u32.SetClipboardData.argtypes = (wintypes.UINT, wintypes.HANDLE)
    u32.SetClipboardData.restype = wintypes.HANDLE
    u32.OpenClipboard.argtypes = (wintypes.HWND,)
    data = text.encode("utf-16-le") + b"\x00\x00"
    for _ in range(10):
        if u32.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        raise AdbError("คลิปบอร์ดของคอมถูกโปรแกรมอื่นใช้อยู่")
    try:
        u32.EmptyClipboard()
        h = k32.GlobalAlloc(0x0002, len(data))
        p = k32.GlobalLock(h)
        ctypes.memmove(p, data, len(data))
        k32.GlobalUnlock(h)
        u32.SetClipboardData(13, h)
    finally:
        u32.CloseClipboard()


class Api:
    def __init__(self):
        self._window = None
        self._adb_path = find_tool("adb")
        self._scrcpy_path = find_tool("scrcpy")
        self._adb = Adb(self._adb_path) if self._adb_path else None
        self._settings = _load_settings()
        self._devices = {}
        self._lock = threading.RLock()
        self._logs = collections.deque(maxlen=300)
        self._closing = False
        self._watching = False
        self._mirrors = {}            # serial -> Popen ของ scrcpy (เปิดได้หลายเครื่องพร้อมกัน)
        self._mirror_stopping = set()
        self._rec = None
        self._rec_started = 0.0
        self._rec_lock = threading.Lock()
        self._task_seq = 0
        self._update = None
        self._update_asset = None

    # ================================================================ plumbing
    def _emit(self, event, data=None):
        w = self._window
        if not w or self._closing:
            return
        try:
            w.evaluate_js(f"window.GG&&GG.onEvent({json.dumps(event)},{json.dumps(data, ensure_ascii=False)})")
        except Exception:  # noqa: BLE001  หน้าต่างกำลังปิด
            pass

    def _log(self, msg, level="info"):
        entry = {"t": datetime.datetime.now().strftime("%H:%M:%S"), "msg": msg, "level": level}
        self._logs.append(entry)
        self._emit("log", entry)

    def _save_settings(self):
        try:
            os.makedirs(CONF_DIR, exist_ok=True)
            with open(CONF_FILE, "w", encoding="utf-8") as f:
                json.dump(self._settings, f, ensure_ascii=False, indent=2)
        except OSError:
            pass

    def _need(self, serial=None):
        """คืน Adb ของเครื่องที่เลือกอยู่ หรือของ serial ที่ระบุ (ใช้กับหน้ารวมทุกเครื่อง)"""
        if not self._adb:
            raise AdbError("ไม่พบ adb — ติดตั้งโปรแกรมใหม่ด้วยตัวติดตั้ง หรือรัน winget install Google.PlatformTools")
        s = serial or self._adb.serial
        d = self._devices.get(s)
        if not d:
            raise AdbError("ยังไม่ได้เสียบมือถือ" if not serial else "มือถือเครื่องนี้หลุดการเชื่อมต่อแล้ว")
        if d["state"] != "device":
            raise AdbError(friendly_error(d["state"]))
        if s == self._adb.serial:
            return self._adb
        other = Adb(self._adb_path)
        other.serial = s
        return other

    def _out_dir(self, sub):
        p = os.path.join(self._settings["save_dir"], sub)
        os.makedirs(p, exist_ok=True)
        return p

    def _stamp(self):
        return datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

    def _task(self, label, total):
        with self._lock:
            self._task_seq += 1
            tid = self._task_seq
        self._emit("task", {"id": tid, "label": label, "done": 0, "total": total})
        return tid

    def _task_step(self, tid, label, done, total, finished=False, error=None):
        self._emit("task", {"id": tid, "label": label, "done": done, "total": total,
                            "finished": finished, "error": error})

    # ================================================================ lifecycle
    def _on_loaded(self):
        if self._window:
            try:
                from webview.dom import DOMEventHandler
                self._window.dom.document.events.drop += DOMEventHandler(self._on_drop, True, True)
            except Exception as e:  # noqa: BLE001
                self._log(f"ลากไฟล์มาวางใช้ไม่ได้ในเครื่องนี้: {e}", "warn")
        if self._adb and not self._watching:
            self._watching = True
            threading.Thread(target=self._watch, daemon=True).start()

    def _on_drop(self, e):
        files = (e.get("dataTransfer") or {}).get("files") or []
        paths = [f.get("pywebviewFullPath") for f in files if f.get("pywebviewFullPath")]
        if paths:
            self._emit("dropped", paths)

    def _on_closing(self):
        self._closing = True
        if self._rec:
            try:
                self._adb.shell("pkill -INT screenrecord", timeout=5)
            except AdbError:
                pass
        if self._settings["close_mirror_on_exit"]:
            self.mirror_stop_all()

    def _watch(self):
        try:
            self._adb.run("start-server", use_serial=False, timeout=30)
        except AdbError as e:
            self._log(f"เริ่มบริการ adb ไม่ได้: {e}", "error")
        last = None
        while not self._closing:
            try:
                _, out, _ = self._adb.run("devices", "-l", use_serial=False, timeout=15)
                devs = parse_devices(out)
            except AdbError:
                devs = None
            if devs is not None and devs != last:
                self._apply_devices(last or {}, devs)
                last = devs
            time.sleep(1.2)

    def _apply_devices(self, old, new):
        with self._lock:
            self._devices = new
            for s, d in new.items():
                name = d["model"] or s
                if s not in old:
                    self._log(f"พบ {name}", "ok" if d["state"] == "device" else "info")
                elif old[s]["state"] != d["state"] and d["state"] == "device":
                    self._log(f"{name} พร้อมใช้งาน", "ok")
            for s in old:
                if s not in new:
                    self._log(f"ถอด {old[s]['model'] or s} แล้ว", "warn")
            prev = self._adb.serial
            cur = prev
            ready = [s for s, d in new.items() if d["state"] == "device"]
            if cur not in new:
                cur = ready[0] if ready else next(iter(new), None)
            self._adb.serial = cur
            # เครื่องที่เพิ่งพร้อมใช้งาน (เสียบใหม่ หรือเพิ่งกดอนุญาต)
            fresh = [s for s, d in new.items() if d["state"] == "device" and old.get(s, {}).get("state") != "device"]
        self._emit("devices", self._device_state())
        if self._settings["auto_mirror"]:
            for s in fresh:
                if not self._mirror_running(s):
                    try:
                        self.mirror_start(s, slot=len(self._running_mirrors()))
                    except AdbError as e:
                        self._log(str(e), "error")

    def _device_state(self):
        cur = self._adb.serial if self._adb else None
        d = self._devices.get(cur) if cur else None
        return {"devices": list(self._devices.values()), "current": cur,
                "state": d["state"] if d else None, "ready": bool(d and d["state"] == "device")}

    # ================================================================ state / settings
    def get_state(self):
        st = {"version": current_version(), "repo": GITHUB_REPO,
              "tools": {"adb": bool(self._adb_path), "scrcpy": bool(self._scrcpy_path)},
              "settings": self._settings, "logs": list(self._logs),
              "mirrors": self._running_mirrors(), "recording": self._rec_status()}
        st.update(self._device_state() if self._adb else {"devices": [], "current": None, "state": None, "ready": False})
        return st

    def select_device(self, serial):
        with self._lock:
            if serial not in self._devices:
                raise AdbError("ไม่พบอุปกรณ์นี้แล้ว")
            self._adb.serial = serial
        state = self._device_state()
        self._emit("devices", state)
        return state

    def settings_set(self, key, value):
        if key not in DEFAULTS or key in ("save_dir", "skip_version") or type(value) is not type(DEFAULTS[key]):
            raise AdbError("ค่าตั้งค่าไม่ถูกต้อง")
        if key == "quality" and value not in QUALITY:
            raise AdbError("ค่าคุณภาพไม่ถูกต้อง")
        self._settings[key] = value
        self._save_settings()
        return self._settings

    def pick_save_dir(self):
        import webview
        res = self._window.create_file_dialog(webview.FileDialog.FOLDER, directory=self._settings["save_dir"])
        if res:
            self._settings["save_dir"] = res[0]
            self._save_settings()
        return self._settings

    def open_path(self, path):
        if not path or not os.path.exists(path):
            raise AdbError("ไม่พบไฟล์นี้ในคอมแล้ว")
        os.startfile(path) if IS_WIN else subprocess.Popen(["xdg-open", path])

    def reveal_path(self, path):
        if IS_WIN and path and os.path.exists(path):
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)], creationflags=NO_WINDOW)
        else:
            self.open_path(os.path.dirname(path))

    def open_save_dir(self, sub=""):
        self.open_path(self._out_dir(sub) if sub else (os.makedirs(self._settings["save_dir"], exist_ok=True)
                                                       or self._settings["save_dir"]))

    def get_logs(self):
        return list(self._logs)

    # ================================================================ update (GitHub Releases)
    def check_update(self):
        """ดูเวอร์ชันล่าสุดบน GitHub คืนข้อมูลที่หน้า UI ใช้แสดงหน้าต่างอัปเดต"""
        import urllib.request
        req = urllib.request.Request(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
                                     headers={"Accept": "application/vnd.github+json", "User-Agent": "GiGoGi"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.load(r)
        except Exception as e:  # noqa: BLE001
            raise AdbError(f"ตรวจอัปเดตไม่ได้ ตรวจการเชื่อมต่ออินเทอร์เน็ต ({e})")
        latest = data.get("tag_name", "").lstrip("v")
        setup = next((a for a in data.get("assets", [])
                      if re.match(r"^GiGoGiPhoneControl-Setup-[\d.]+\.exe$", a.get("name", ""))
                      and a.get("browser_download_url", "").startswith(UPDATE_URL_PREFIX)), None)
        cur = current_version()
        self._update = {
            "current": cur, "latest": latest, "url": data.get("html_url", ""),
            "notes": (data.get("body") or "")[:4000], "published": (data.get("published_at") or "")[:10],
            "newer": bool(latest) and version_tuple(latest) > version_tuple(cur),
            "size": setup.get("size") if setup else None,
            "can_auto": bool(setup) and can_self_update(),
            "skipped": self._settings["skip_version"] == latest,
        }
        self._update_asset = setup
        return self._update

    def update_skip(self, version):
        self._settings["skip_version"] = str(version or "")
        self._save_settings()

    def update_install(self):
        """ดาวน์โหลดตัวติดตั้งเวอร์ชันใหม่ ตรวจไฟล์ แล้วติดตั้งแบบเงียบ โปรแกรมจะปิดและเปิดใหม่เอง"""
        info = getattr(self, "_update", None)
        asset = getattr(self, "_update_asset", None)
        if not info or not info["newer"] or not asset:
            raise AdbError("ยังไม่มีเวอร์ชันใหม่ให้ติดตั้ง ลองตรวจหาอัปเดตอีกครั้ง")
        if not info["can_auto"]:
            raise AdbError("โปรแกรมนี้ไม่ได้ติดตั้งด้วยตัวติดตั้ง ให้ดาวน์โหลดจากหน้า GitHub แทน")
        import urllib.request
        folder = os.path.join(os.environ.get("TEMP", os.path.expanduser("~")), "GiGoGi-update")
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, asset["name"])
        part = path + ".part"
        total = int(asset.get("size") or 0)
        req = urllib.request.Request(asset["browser_download_url"], headers={"User-Agent": "GiGoGi"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r, open(part, "wb") as f:
                if not r.geturl().startswith(("https://github.com/", "https://objects.githubusercontent.com/",
                                              "https://release-assets.githubusercontent.com/")):
                    raise AdbError("ที่อยู่ดาวน์โหลดไม่ใช่ GitHub")
                done, last = 0, 0.0
                while True:
                    chunk = r.read(256 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if time.time() - last > 0.25:
                        last = time.time()
                        self._emit("update", {"phase": "download", "done": done, "total": total})
        except AdbError:
            raise
        except Exception as e:  # noqa: BLE001
            raise AdbError(f"ดาวน์โหลดไม่สำเร็จ ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองใหม่ ({e})")
        with open(part, "rb") as f:
            head = f.read(2)
        if (total and os.path.getsize(part) != total) or head != b"MZ":
            os.remove(part)
            raise AdbError("ไฟล์ที่ดาวน์โหลดไม่สมบูรณ์ ลองอีกครั้ง")
        os.replace(part, path)
        self._emit("update", {"phase": "install", "done": total, "total": total})
        self._log(f"ดาวน์โหลดเวอร์ชัน {info['latest']} แล้ว กำลังติดตั้ง", "ok")
        if os.environ.get("GIGOGI_UPDATE_DRYRUN"):
            return {"path": path, "dryrun": True}
        # ปิดจอสดและบริการ adb ของโปรแกรม เพื่อให้ไฟล์ถูกแทนที่ได้
        self._settings["close_mirror_on_exit"] = True
        self._on_closing()
        try:
            if self._adb:
                self._adb.run("kill-server", use_serial=False, timeout=10)
        except AdbError:
            pass
        subprocess.Popen([path, "/SILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/CLOSEAPPLICATIONS", "/RELAUNCH"],
                         creationflags=0x00000008 | 0x00000200, close_fds=True)  # DETACHED | NEW_PROCESS_GROUP

        def close():
            time.sleep(0.8)
            try:
                self._window.destroy()
            except Exception:  # noqa: BLE001
                os._exit(0)
        threading.Thread(target=close, daemon=True).start()
        return {"path": path}

    def open_url_pc(self, url):
        if not re.match(r"^https://", url or ""):
            raise AdbError("ลิงก์ไม่ถูกต้อง")
        import webbrowser
        webbrowser.open(url)

    # ================================================================ device info
    def device_info(self):
        a = self._need()
        parts = a.sh_out(
            "settings get global device_name; getprop ro.product.marketname; getprop ro.product.manufacturer; "
            "getprop ro.product.model; getprop ro.build.version.release; getprop ro.build.version.sdk; echo @@; "
            "dumpsys battery; echo @@; df /data | tail -1; echo @@; wm size; wm density; echo @@; "
            "head -3 /proc/meminfo; echo @@; ip -f inet addr show wlan0; echo @@; cat /proc/uptime",
            timeout=20).split("@@")
        parts += [""] * (7 - len(parts))
        p = (parts[0].strip().splitlines() + [""] * 6)[:6]
        name = next((x for x in (p[0], p[1]) if x and x != "null"), "") or p[3]
        bat = parse_kv(parts[1])
        df = parts[2].split()
        total = used = None
        if len(df) >= 4:
            total, used = _to_bytes(df[1]), _to_bytes(df[2])
        size = parse_wm_size(parts[3])
        dens = re.search(r"(Override|Physical) density:\s*(\d+)", parts[3])
        mem = {k: int(re.sub(r"\D", "", v) or 0) * 1024 for k, v in parse_kv(parts[4]).items()}
        ip = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", parts[5])
        up = parts[6].split()
        temp = bat.get("temperature", "")
        sources = [n for k, n in (("AC powered", "ไฟบ้าน"), ("USB powered", "USB"), ("Wireless powered", "ไร้สาย"))
                   if bat.get(k) == "true"]
        return {
            "name": name, "brand": p[2].capitalize(), "model": p[3], "android": p[4], "sdk": p[5],
            "serial": a.serial,
            "battery": int(bat.get("level") or 0) if (bat.get("level") or "").isdigit() else None,
            "charging": bat.get("status") in ("2", "5"), "full": bat.get("status") == "5",
            "power_source": ", ".join(sources),
            "temp": int(temp) / 10 if temp.isdigit() else None,
            "storage_total": total, "storage_used": used,
            "mem_total": mem.get("MemTotal"), "mem_avail": mem.get("MemAvailable"),
            "screen": f"{size[0]} × {size[1]}" if size else "", "density": dens.group(2) if dens else "",
            "ip": ip.group(1) if ip else "",
            "uptime": int(float(up[0])) if up else None,
        }

    # ================================================================ screen
    def screen_frame(self, max_side=1400, serial=None):
        a = self._need(serial)
        code, data, err = a.run("exec-out", "screencap -p", binary=True, timeout=15)
        i = data.find(b"\x89PNG")
        if i < 0:
            raise AdbError(friendly_error(err) if err.strip() else "จับภาพหน้าจอไม่ได้")
        from PIL import Image
        im = Image.open(io.BytesIO(data[i:]))
        w, h = im.size
        scale = min(1.0, max_side / max(w, h))
        im = im.convert("RGB")
        if scale < 1:
            im = im.resize((int(w * scale), int(h * scale)), Image.BILINEAR)
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=74)
        return {"img": "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode("ascii"), "w": w, "h": h}

    def device_brief(self, serial):
        """ข้อมูลย่อสำหรับหน้ารวมทุกเครื่อง: ชื่อเครื่อง แบต และการชาร์จ"""
        a = self._need(serial)
        out = a.sh_out("settings get global device_name; getprop ro.product.marketname; "
                       "getprop ro.product.model; echo @@; dumpsys battery", timeout=15)
        head, _, bat = out.partition("@@")
        names = [x.strip() for x in head.strip().splitlines()] + ["", "", ""]
        name = next((x for x in names[:3] if x and x != "null"), "")
        b = parse_kv(bat)
        level = b.get("level", "")
        return {"serial": serial, "name": name, "battery": int(level) if level.isdigit() else None,
                "charging": b.get("status") in ("2", "5")}

    def screenshot(self, serial=None):
        a = self._need(serial)
        code, data, err = a.run("exec-out", "screencap -p", binary=True, timeout=20)
        i = data.find(b"\x89PNG")
        if i < 0:
            raise AdbError("แคปหน้าจอไม่ได้ (แอพบางตัว เช่น แอพธนาคาร ไม่อนุญาตให้แคป)")
        tag = "" if not serial else "_" + re.sub(r"[^\w.-]", "_", self._devices.get(serial, {}).get("model") or serial)
        path = os.path.join(self._out_dir("Screenshots"), f"screen_{self._stamp()}{tag}.png")
        with open(path, "wb") as f:
            f.write(data[i:])
        self._log(f"บันทึกภาพหน้าจอแล้ว: {os.path.basename(path)}", "ok")
        return path

    def _rec_status(self):
        return {"active": self._rec is not None,
                "elapsed": int(time.time() - self._rec_started) if self._rec else 0}

    def record_start(self):
        a = self._need()
        with self._rec_lock:
            if self._rec:
                return self._rec_status()
            a.shell(f"rm -f {REMOTE_REC}")
            self._rec = a.popen("shell", f"screenrecord --time-limit 180 {REMOTE_REC}")
            self._rec_started = time.time()
            proc = self._rec
        self._log("เริ่มอัดหน้าจอ (ยาวสุด 3 นาที)", "ok")

        def watch():
            proc.wait()
            if self._rec is proc and not self._closing:  # ครบ 3 นาทีแล้วหยุดเอง
                try:
                    path = self._record_finish(proc)
                    self._emit("record", {"active": False, "path": path})
                except AdbError as e:
                    self._emit("record", {"active": False, "error": str(e)})
        threading.Thread(target=watch, daemon=True).start()
        return self._rec_status()

    def record_stop(self):
        with self._rec_lock:
            proc = self._rec
        if not proc:
            raise AdbError("ยังไม่ได้อัดหน้าจอ")
        self._adb.shell("pkill -INT screenrecord")
        return {"active": False, "path": self._record_finish(proc)}

    def _record_finish(self, proc):
        with self._rec_lock:
            if self._rec is not proc:
                raise AdbError("บันทึกวิดีโอไปแล้ว")
            self._rec = None
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        time.sleep(0.8)  # รอให้มือถือเขียนไฟล์ mp4 ให้เสร็จ
        path = os.path.join(self._out_dir("Recordings"), f"record_{self._stamp()}.mp4")
        self._adb.run("pull", REMOTE_REC, path, timeout=300, check=True)
        self._adb.shell(f"rm -f {REMOTE_REC}")
        self._log(f"บันทึกวิดีโอแล้ว: {os.path.basename(path)}", "ok")
        return path

    # ================================================================ input
    def input_tap(self, x, y):
        self._need().shell(f"input tap {int(x)} {int(y)}", check=True)

    def input_swipe(self, x1, y1, x2, y2, ms=250):
        ms = max(50, min(int(ms), 3000))
        self._need().shell(f"input swipe {int(x1)} {int(y1)} {int(x2)} {int(y2)} {ms}", check=True)

    def input_key(self, code, serial=None):
        code = str(code)
        if not KEY_RE.match(code):
            raise AdbError("ปุ่มไม่ถูกต้อง")
        self._need(serial).shell(f"input keyevent {code}", check=True)

    def broadcast_key(self, code):
        """ส่งปุ่มเดียวกันไปทุกเครื่องที่พร้อมใช้งาน คืนจำนวนเครื่องที่สำเร็จ"""
        ok = 0
        for s, d in list(self._devices.items()):
            if d["state"] == "device":
                try:
                    self.input_key(code, s)
                    ok += 1
                except AdbError as e:
                    self._log(f"{d['model'] or s}: {e}", "error")
        return ok

    def screenshot_all(self):
        paths = []
        for s, d in list(self._devices.items()):
            if d["state"] == "device":
                try:
                    paths.append(self.screenshot(s))
                except AdbError as e:
                    self._log(f"{d['model'] or s}: {e}", "error")
        return {"count": len(paths), "dir": self._out_dir("Screenshots"), "last": paths[-1] if paths else ""}

    def input_text(self, text):
        a = self._need()
        if not text:
            return {"sent": False}
        if any(ord(c) > 126 or ord(c) < 32 for c in text):
            set_clipboard(text)
            if self._mirror_running(a.serial):
                time.sleep(0.4)  # ให้ scrcpy ส่งคลิปบอร์ดไปที่มือถือก่อน
                a.shell("input keyevent 279", check=True)  # KEYCODE_PASTE
                return {"sent": True, "via": "paste"}
            return {"sent": False, "via": "clipboard"}
        for i in range(0, len(text), 120):
            a.shell("input text " + shq(text[i:i + 120].replace(" ", "%s")), check=True)
        return {"sent": True, "via": "type"}

    def open_link(self, url):
        url = (url or "").strip()
        if not url:
            raise AdbError("ใส่ลิงก์ก่อน")
        if not re.match(r"^[a-zA-Z][\w+.-]*:", url):
            url = "https://" + url
        self._need().shell("am start -a android.intent.action.VIEW -d " + shq(url), check=True)
        return url

    def unlock(self):
        a = self._need()
        a.shell("input keyevent KEYCODE_WAKEUP", check=True)
        size = parse_wm_size(a.sh_out("wm size")) or (1080, 2400)
        time.sleep(0.3)
        w, h = size
        a.shell(f"input swipe {w // 2} {int(h * 0.85)} {w // 2} {int(h * 0.3)} 220", check=True)

    def shade(self, which="notifications"):
        cmd = {"notifications": "expand-notifications", "settings": "expand-settings", "close": "collapse"}
        self._need().shell(f"cmd statusbar {cmd.get(which, 'collapse')}", check=True)

    # ================================================================ mirror (scrcpy)
    def _mirror_running(self, serial=None):
        p = self._mirrors.get(serial or (self._adb.serial if self._adb else None))
        return p is not None and p.poll() is None

    def _running_mirrors(self):
        return [s for s, p in list(self._mirrors.items()) if p.poll() is None]

    @staticmethod
    def _work_area():
        """พื้นที่จอคอมที่ไม่รวมแถบงาน (left, top, right, bottom)"""
        if IS_WIN:
            try:
                import ctypes
                from ctypes import wintypes
                r = wintypes.RECT()
                if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(r), 0):
                    return r.left, r.top, r.right, r.bottom
            except Exception:  # noqa: BLE001
                pass
        return 0, 0, 1920, 1040

    def mirror_start(self, serial=None, slot=None):
        """เปิดหน้าต่างจอสดของเครื่องหนึ่ง slot = ลำดับหน้าต่าง ใช้เรียงหน้าต่างไม่ให้ซ้อนกัน"""
        a = self._need(serial)
        if not self._scrcpy_path:
            raise AdbError("ไม่พบ scrcpy — ติดตั้งโปรแกรมใหม่ด้วยตัวติดตั้ง")
        if self._mirror_running(a.serial):
            return True
        s = self._settings
        size, rate = QUALITY[s["quality"]]
        name = self._devices.get(a.serial, {}).get("model") or "Android"
        args = [self._scrcpy_path, "-s", a.serial, "--window-title", f"{name} - GiGoGi", "--video-bit-rate", rate]
        if size:
            args += ["--max-size", size]
        if slot is not None:
            left, top, right, bottom = self._work_area()
            h = max(480, int((bottom - top) * 0.86))
            w = int(h * 0.47) + 16
            per_row = max(1, (right - left - 24) // (w + 14))
            x = left + 24 + (slot % per_row) * (w + 14)
            y = top + 40 + (slot // per_row) * 36
            args += ["--window-x", str(x), "--window-y", str(y), "--window-height", str(h)]
        for key, flag in (("stay_awake", "--stay-awake"), ("screen_off", "--turn-screen-off"),
                          ("on_top", "--always-on-top"), ("show_touches", "--show-touches")):
            if s[key]:
                args.append(flag)
        if not s["audio"]:
            args.append("--no-audio")
        if s["record_mirror"]:
            rec = os.path.join(self._out_dir("Recordings"), f"mirror_{self._stamp()}.mp4")
            args += ["--record", rec]
        env = os.environ.copy()
        env["ADB"] = self._adb_path  # ใช้ adb ตัวเดียวกัน ไม่ให้ server สองเวอร์ชันชนกัน
        icons = os.path.join(RES_DIR, "ui", "scrcpy-icons")
        if os.path.isdir(icons):
            env["SCRCPY_ICON_DIR"] = icons  # ไอคอนหน้าต่างจอสดเป็นโลโก้ GiGoGi แทนหุ่นยนต์ Android
        try:
            proc = subprocess.Popen(args, env=env, cwd=os.path.dirname(self._scrcpy_path),
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        except OSError as e:
            raise AdbError(f"เปิดจอสดไม่ได้: {e}")
        self._mirrors[a.serial] = proc
        self._mirror_stopping.discard(a.serial)
        self._log(f"เปิดจอสด {name} แล้ว", "ok")
        self._emit("mirror", {"serial": a.serial, "running": True, "mirrors": self._running_mirrors()})
        threading.Thread(target=self._mirror_reader, args=(proc, a.serial, name), daemon=True).start()
        return True

    def mirror_start_all(self):
        ready = [s for s, d in self._devices.items() if d["state"] == "device"]
        if not ready:
            raise AdbError("ยังไม่มีมือถือที่พร้อมใช้งาน")
        n = 0
        for i, s in enumerate(ready):
            if not self._mirror_running(s):
                self.mirror_start(s, slot=i)
                n += 1
                time.sleep(0.3)
        return n

    def mirror_stop_all(self):
        for s in self._running_mirrors():
            self.mirror_stop(s)

    def _mirror_reader(self, proc, serial, name):
        tail = []
        for raw in proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if line:
                tail = (tail + [line])[-20:]
        code = proc.wait()
        if self._mirrors.get(serial) is proc:
            self._mirrors.pop(serial, None)
        if self._closing:
            return
        text = "\n".join(tail)
        base = {"serial": serial, "running": False, "mirrors": self._running_mirrors()}
        if code == 0 or serial in self._mirror_stopping:
            self._mirror_stopping.discard(serial)
            self._log(f"ปิดจอสด {name} แล้ว")
            self._emit("mirror", base)
            return
        if "INJECT_EVENTS" in text:
            msg = friendly_error("INJECT_EVENTS")
        elif re.search(r"encoder|codec", text, re.I):
            msg = "มือถือเข้ารหัสวิดีโอความละเอียดนี้ไม่ได้ — ลองเลือกคุณภาพ 'ประหยัด' ในตั้งค่า"
        elif "Could not find any ADB device" in text or "not found" in text:
            msg = "จอสดหยุดเพราะมือถือหลุดการเชื่อมต่อ"
        else:
            err = [l for l in tail if l.startswith("ERROR")]
            msg = "จอสดหยุดทำงาน: " + (err[-1][6:].strip() if err else f"รหัส {code}")
        msg = f"{name}: {msg}"
        self._log(msg, "error")
        self._emit("mirror", dict(base, error=msg))

    def mirror_stop(self, serial=None):
        s = serial or (self._adb.serial if self._adb else None)
        p = self._mirrors.get(s)
        if p is not None and p.poll() is None:
            self._mirror_stopping.add(s)
            p.terminate()
        return False

    # ================================================================ files
    def files_list(self, path):
        a = self._need()
        path = posixpath.normpath("/" + (path or "/sdcard").strip().lstrip("/"))
        code, out, err = a.shell(f"ls -la {shq(path.rstrip('/') + '/')}", timeout=30)
        if "Not a directory" in out + err:
            return {"path": path, "notDir": True, "items": []}
        items = parse_ls(out)
        if not items and re.search(r"No such file|Permission denied", out + err):
            raise AdbError(friendly_error(err or out))
        return {"path": path, "items": items}

    def files_pull(self, remote_paths, open_after=False):
        a = self._need()
        dest = self._out_dir("Downloads")
        total = len(remote_paths)
        tid = self._task(f"กำลังดาวน์โหลด {total} รายการ", total)
        last = dest
        for i, rp in enumerate(remote_paths):
            name = posixpath.basename(rp.rstrip("/"))
            self._task_step(tid, f"กำลังดาวน์โหลด {name}", i, total)
            try:
                a.run("pull", rp, dest, timeout=None, check=True)
            except AdbError as e:
                self._task_step(tid, f"ดาวน์โหลด {name} ไม่สำเร็จ", i, total, True, str(e))
                raise
            last = os.path.join(dest, name)
        self._task_step(tid, f"ดาวน์โหลดแล้ว {total} รายการ", total, total, True)
        self._log(f"ดาวน์โหลด {total} รายการไปที่ {dest}", "ok")
        if open_after and total == 1 and os.path.isfile(last):
            self.open_path(last)
        return {"dir": dest, "last": last}

    def files_push(self, local_paths, dest):
        a = self._need()
        local_paths = [p for p in local_paths if p and os.path.exists(p)]
        if not local_paths:
            raise AdbError("ไม่พบไฟล์ที่เลือกในคอม")
        dest = dest.rstrip("/") + "/"
        total = len(local_paths)
        tid = self._task(f"กำลังส่ง {total} รายการไปมือถือ", total)
        for i, lp in enumerate(local_paths):
            name = os.path.basename(lp.rstrip("\\/"))
            self._task_step(tid, f"กำลังส่ง {name}", i, total)
            try:
                a.run("push", lp, dest, timeout=None, check=True)
            except AdbError as e:
                self._task_step(tid, f"ส่ง {name} ไม่สำเร็จ", i, total, True, str(e))
                raise
        self._task_step(tid, f"ส่งแล้ว {total} รายการ", total, total, True)
        self._log(f"ส่ง {total} รายการไปที่ {dest}", "ok")
        return total

    def files_push_dialog(self, dest, folder=False):
        import webview
        if folder:
            res = self._window.create_file_dialog(webview.FileDialog.FOLDER)
        else:
            res = self._window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=True)
        if not res:
            return 0
        return self.files_push(list(res), dest)

    def files_mkdir(self, parent, name):
        self._check_name(name)
        self._need().shell(f"mkdir -p {shq(posixpath.join(parent, name))}", check=True)

    def files_rename(self, path, new_name):
        self._check_name(new_name)
        target = posixpath.join(posixpath.dirname(path.rstrip("/")), new_name)
        self._need().shell(f"mv -n {shq(path)} {shq(target)}", check=True)

    def files_delete(self, paths):
        a = self._need()
        bad = [p for p in paths if posixpath.normpath(p) in ("/", "/sdcard", "/storage", "/storage/emulated/0", "/data", "/system")]
        if bad:
            raise AdbError("ลบโฟลเดอร์หลักของระบบไม่ได้")
        a.shell("rm -rf " + " ".join(shq(p) for p in paths), timeout=120, check=True)
        self._log(f"ลบ {len(paths)} รายการแล้ว", "ok")

    @staticmethod
    def _check_name(name):
        if not name or "/" in name or name in (".", ".."):
            raise AdbError("ชื่อนี้ใช้ไม่ได้ (ห้ามมีเครื่องหมาย /)")

    # ================================================================ apps
    def apps_list(self, kind="user"):
        a = self._need()
        flag = {"user": "-3", "system": "-s", "disabled": "-d"}.get(kind, "-3")
        out = a.sh_out(f"pm list packages {flag}; echo @@; pm list packages -d", timeout=30)
        main, _, dis = out.partition("@@")
        disabled = {l.split(":", 1)[1].strip() for l in dis.splitlines() if ":" in l}
        pkgs = sorted({l.split(":", 1)[1].strip() for l in main.splitlines() if ":" in l})
        return [{"pkg": p, "disabled": p in disabled} for p in pkgs]

    def _pkg(self, pkg):
        if not PKG_RE.match(pkg or ""):
            raise AdbError("ชื่อแพ็กเกจไม่ถูกต้อง")
        return pkg

    def app_detail(self, pkg):
        a = self._need()
        pkg = self._pkg(pkg)
        d = a.sh_out(f"dumpsys package {shq(pkg)}", timeout=30)
        def g(k):
            m = re.search(rf"\b{k}=([^\s]+(?: [\d:]+)?)", d)
            return m.group(1) if m else ""
        paths = [l.replace("package:", "").strip() for l in a.sh_out(f"pm path {shq(pkg)}").splitlines() if l.strip()]
        size = 0
        if paths:
            for n in a.sh_out("stat -c %s " + " ".join(shq(p) for p in paths)).split():
                size += int(n) if n.isdigit() else 0
        flags = re.search(r"pkgFlags=\[([^\]]*)\]", d)
        return {"pkg": pkg, "version": g("versionName"), "code": g("versionCode").split()[0] if g("versionCode") else "",
                "installed": g("firstInstallTime"), "updated": g("lastUpdateTime"),
                "target": g("targetSdk"), "installer": g("installerPackageName"),
                "system": bool(flags and "SYSTEM" in flags.group(1)),
                "disabled": pkg in a.sh_out("pm list packages -d").replace("package:", "").split(),
                "size": size or None, "splits": len(paths)}

    def app_launch(self, pkg):
        out = self._need().sh_out(f"monkey -p {shq(self._pkg(pkg))} -c android.intent.category.LAUNCHER 1")
        if "No activities found" in out or "aborted" in out:
            raise AdbError("แอพนี้ไม่มีหน้าจอให้เปิด")

    def app_stop(self, pkg):
        self._need().shell(f"am force-stop {shq(self._pkg(pkg))}", check=True)

    def app_clear(self, pkg):
        out = self._need().sh_out(f"pm clear {shq(self._pkg(pkg))}")
        if "Success" not in out:
            raise AdbError(friendly_error(out or "ล้างข้อมูลไม่สำเร็จ"))
        self._log(f"ล้างข้อมูล {pkg} แล้ว", "ok")

    def app_uninstall(self, pkg):
        a = self._need()
        pkg = self._pkg(pkg)
        if self.app_detail(pkg)["system"]:
            raise AdbError("แอพระบบถอนไม่ได้ ใช้ 'ปิดใช้งาน' แทน")
        _, out, err = a.run("uninstall", pkg, timeout=120)
        if "Success" not in out:
            raise AdbError(friendly_error(err or out))
        self._log(f"ถอน {pkg} แล้ว", "ok")

    def app_set_enabled(self, pkg, enabled):
        pkg = self._pkg(pkg)
        cmd = f"pm enable {shq(pkg)}" if enabled else f"pm disable-user --user 0 {shq(pkg)}"
        out = self._need().sh_out(cmd)
        if "new state" not in out:
            raise AdbError(friendly_error(out or "เปลี่ยนสถานะไม่สำเร็จ"))
        self._log(f"{'เปิด' if enabled else 'ปิด'}ใช้งาน {pkg} แล้ว", "ok")

    def app_pull(self, pkg):
        a = self._need()
        pkg = self._pkg(pkg)
        paths = [l.replace("package:", "").strip() for l in a.sh_out(f"pm path {shq(pkg)}").splitlines() if l.strip()]
        if not paths:
            raise AdbError("หาไฟล์ APK ของแอพนี้ไม่พบ")
        dest = self._out_dir("APK")
        if len(paths) > 1:
            dest = os.path.join(dest, pkg)
            os.makedirs(dest, exist_ok=True)
        last = dest
        for rp in paths:
            last = os.path.join(dest, f"{pkg}.apk" if len(paths) == 1 else posixpath.basename(rp))
            a.run("pull", rp, last, timeout=None, check=True)
        self._log(f"ดึง APK ของ {pkg} แล้ว", "ok")
        return last

    def app_install(self, paths):
        a = self._need()
        apks = [p for p in paths if p.lower().endswith(".apk") and os.path.isfile(p)]
        if not apks:
            raise AdbError("เลือกไฟล์ .apk")
        total = len(apks)
        tid = self._task(f"กำลังติดตั้ง {total} แอพ", total)
        results = []
        for i, p in enumerate(apks):
            name = os.path.basename(p)
            self._task_step(tid, f"กำลังติดตั้ง {name} — ถ้ามือถือถาม ให้กดยืนยัน", i, total)
            _, out, err = a.run("install", "-r", p, timeout=None)
            ok = "Success" in out
            msg = "" if ok else friendly_error(re.sub(r".*Failure \[", "", (err or out)).rstrip("]"))
            results.append({"name": name, "ok": ok, "error": msg})
            self._log(f"ติดตั้ง {name} {'สำเร็จ' if ok else 'ไม่สำเร็จ: ' + msg}", "ok" if ok else "error")
        okn = sum(r["ok"] for r in results)
        self._task_step(tid, f"ติดตั้งสำเร็จ {okn} จาก {total}", total, total, True,
                        None if okn == total else "บางไฟล์ติดตั้งไม่สำเร็จ")
        return results

    def app_install_dialog(self):
        import webview
        res = self._window.create_file_dialog(webview.FileDialog.OPEN, allow_multiple=True,
                                              file_types=("ไฟล์แอพ Android (*.apk)",))
        return self.app_install(list(res)) if res else []

    # ================================================================ tools
    def shell(self, command):
        command = (command or "").strip()
        if not command:
            return {"code": 0, "out": ""}
        code, out, err = self._need().shell(command, timeout=60)
        return {"code": code, "out": (out + err).rstrip()[-60000:]}

    def wifi_enable(self):
        a = self._need()
        if self._devices.get(a.serial, {}).get("transport") == "wifi":
            raise AdbError("ตอนนี้เชื่อมต่อผ่าน Wi‑Fi อยู่แล้ว")
        ip = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", a.sh_out("ip -f inet addr show wlan0"))
        if not ip:
            raise AdbError("มือถือยังไม่ได้ต่อ Wi‑Fi")
        a.run("tcpip", "5555", timeout=20, check=True)
        time.sleep(2.5)
        return self.wifi_connect(f"{ip.group(1)}:5555")

    def wifi_connect(self, addr):
        addr = (addr or "").strip()
        if not re.match(r"^[\w.-]+(:\d{2,5})?$", addr):
            raise AdbError("ใส่ที่อยู่แบบ 192.168.1.20:5555")
        if ":" not in addr:
            addr += ":5555"
        _, out, err = self._adb.run("connect", addr, use_serial=False, timeout=20)
        text = (out + err).strip()
        if "connected" not in text or "cannot" in text or "failed" in text:
            raise AdbError(f"เชื่อมต่อ {addr} ไม่ได้ — ตรวจว่าอยู่ Wi‑Fi เดียวกัน ({text})")
        self._log(f"เชื่อมต่อผ่าน Wi‑Fi: {addr}", "ok")
        return addr

    def wifi_pair(self, addr, code):
        if not re.match(r"^[\w.-]+:\d{2,5}$", (addr or "").strip()) or not re.match(r"^\d{6}$", (code or "").strip()):
            raise AdbError("ใส่ที่อยู่แบบ 192.168.1.20:37099 และรหัส 6 หลัก")
        _, out, err = self._adb.run("pair", addr.strip(), code.strip(), use_serial=False, timeout=30)
        if "Successfully paired" not in out + err:
            raise AdbError("จับคู่ไม่สำเร็จ — ตรวจรหัสและพอร์ตในหน้า 'แก้ไขข้อบกพร่องผ่าน Wi‑Fi'")
        self._log(f"จับคู่ {addr} แล้ว", "ok")
        return True

    def wifi_disconnect(self, serial):
        self._adb.run("disconnect", serial, use_serial=False, timeout=15)
        self._log(f"ตัดการเชื่อมต่อ {serial}")

    def reboot(self, mode=""):
        if mode not in ("", "recovery", "bootloader"):
            raise AdbError("โหมดไม่ถูกต้อง")
        a = self._need()
        a.run(*(("reboot", mode) if mode else ("reboot",)), timeout=30)
        self._log({"": "สั่งรีสตาร์ทมือถือแล้ว", "recovery": "สั่งเข้า Recovery แล้ว",
                   "bootloader": "สั่งเข้า Bootloader แล้ว"}[mode], "ok")

    def adb_restart(self):
        if not self._adb:
            raise AdbError("ไม่พบ adb")
        self._adb.run("kill-server", use_serial=False, timeout=15)
        self._adb.run("start-server", use_serial=False, timeout=30)
        self._log("เริ่มบริการ adb ใหม่แล้ว", "ok")
