#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GiGoGi Phone Control — ควบคุมมือถือ Android ผ่านสาย USB
ใช้ adb (Android Platform-Tools) และ scrcpy

รัน:  python phone_control.py            (เปิดโปรแกรม)
      python phone_control.py --selftest (ตรวจเครื่องมือ/อุปกรณ์ แบบไม่เปิดหน้าต่าง)
      python phone_control.py --smoke    (เปิดหน้าต่าง 3 วินาทีแล้วปิด)
"""

import base64
import datetime
import glob
import json
import os
import posixpath
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
import tkinter.font  # noqa: F401
from tkinter import ttk, filedialog, messagebox, simpledialog

from version import __version__, GITHUB_REPO

APP_TITLE = "GiGoGi Phone Control"
IS_WIN = os.name == "nt"
NO_WINDOW = 0x08000000 if IS_WIN else 0
FROZEN = getattr(sys, "frozen", False)  # รันจาก .exe ที่สร้างด้วย PyInstaller
APP_DIR = os.path.dirname(sys.executable if FROZEN else os.path.abspath(__file__))
CONF_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "GiGoGiPhoneControl")
CONF_FILE = os.path.join(CONF_DIR, "settings.json")
HOME = os.path.expanduser("~")
OUT_PICTURES = os.path.join(HOME, "Pictures", "PhoneControl")
OUT_VIDEOS = os.path.join(HOME, "Videos", "PhoneControl")
FONT = "Leelawadee UI" if IS_WIN else "TkDefaultFont"

DEFAULT_SETTINGS = {
    "auto_mirror": False,
    "max_size": "1280",
    "bitrate": "8M",
    "stay_awake": True,
    "screen_off": False,
    "on_top": False,
    "show_touches": False,
    "no_audio": False,
    "fullscreen": False,
    "record": False,
    "show_system_apps": False,
}

HELP_TEXT = """วิธีเชื่อมต่อมือถือ Android กับโปรแกรม

1) เปิดโหมดนักพัฒนา (Developer options)
   ตั้งค่า > เกี่ยวกับโทรศัพท์ > แตะ "หมายเลขบิลด์" (Build number) 7 ครั้ง
   (Xiaomi: แตะ "เวอร์ชัน MIUI/HyperOS", Samsung: ข้อมูลซอฟต์แวร์ > หมายเลขบิลด์)

2) เปิด "การแก้ไขข้อบกพร่อง USB" (USB debugging)
   ตั้งค่า > ระบบ > ตัวเลือกสำหรับนักพัฒนา > USB debugging = เปิด
   * Xiaomi / POCO / Redmi: เปิด "USB debugging (Security settings)" ด้วย
     ไม่งั้นจะเห็นจอแต่แตะ/กดปุ่มไม่ได้ (ต้องใส่ซิมและล็อกอิน Mi Account)

3) เสียบสาย USB เข้าคอม
   ถ้ามือถือถามโหมด USB ให้เลือก "ถ่ายโอนไฟล์" (File transfer)

4) บนมือถือจะมีหน้าต่าง "อนุญาตการแก้ไขข้อบกพร่อง USB หรือไม่?"
   ติ๊ก "อนุญาตจากคอมพิวเตอร์เครื่องนี้เสมอ" แล้วกด "อนุญาต"

ถ้ายังไม่ขึ้น:
 • เปลี่ยนสาย USB (สายชาร์จบางเส้นส่งข้อมูลไม่ได้) หรือเปลี่ยนพอร์ต
 • ลงไดรเวอร์ของยี่ห้อมือถือ (เช่น Samsung USB Driver) หรือ Google USB Driver
 • ปิด-เปิด USB debugging ใหม่ หรือกด "เพิกถอนการอนุญาต USB debugging" แล้วเสียบใหม่
 • กดปุ่ม "รีสตาร์ท adb" ในโปรแกรม

เคล็ดลับหน้าต่างจอสด (scrcpy):
 • คลิกขวา = Back,  คลิกกลาง = Home
 • Ctrl+V = วางข้อความจากคอม (ใช้พิมพ์ภาษาไทย)
 • ลากไฟล์ .apk ใส่หน้าต่าง = ติดตั้ง, ลากไฟล์อื่น = ส่งไปที่ /sdcard/Download
 • Alt+O = ปิดจอมือถือ (แต่ยังควบคุมได้),  Alt+F = เต็มจอ
"""


# ----------------------------------------------------------------- utilities
def registry_path_dirs():
    """อ่าน PATH จาก Registry (กรณีโปรแกรมถูกเปิดก่อนติดตั้งเครื่องมือ PATH จะเก่า)"""
    dirs = []
    if not IS_WIN:
        return dirs
    try:
        import winreg
    except ImportError:
        return dirs
    keys = ((winreg.HKEY_CURRENT_USER, r"Environment"),
            (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"))
    for root, sub in keys:
        try:
            with winreg.OpenKey(root, sub) as k:
                val, _ = winreg.QueryValueEx(k, "Path")
                dirs += [os.path.expandvars(d.strip()) for d in val.split(";") if d.strip()]
        except OSError:
            pass
    return dirs


def find_tool(name):
    exe = name + (".exe" if IS_WIN else "")
    # 1) เครื่องมือที่มากับตัวติดตั้ง (tools\scrcpy\) — ใช้ก่อนเสมอ เพื่อให้เวอร์ชันตรงกัน
    for c in (os.path.join(APP_DIR, "tools", exe), os.path.join(APP_DIR, "tools", "*", exe)):
        for m in sorted(glob.glob(c)):
            if os.path.isfile(m):
                return m
    found = shutil.which(name)
    if found:
        return found
    cands = [os.path.join(d, exe) for d in registry_path_dirs()]
    la = os.environ.get("LOCALAPPDATA", "")
    if la:
        pk = os.path.join(la, "Microsoft", "WinGet", "Packages")
        if name == "adb":  # ใช้ adb ของ Google ก่อน adb ที่แถมมากับ scrcpy
            cands.append(os.path.join(pk, "Google.PlatformTools*", "platform-tools", exe))
        cands += [os.path.join(la, "Microsoft", "WinGet", "Links", exe),
                  os.path.join(pk, "*", exe),
                  os.path.join(pk, "*", "*", exe),
                  os.path.join(la, "Android", "Sdk", "platform-tools", exe)]
    for c in cands:
        for m in sorted(glob.glob(c), reverse=True):
            if os.path.isfile(m):
                return m
    return None


def shq(s):
    """ครอบข้อความด้วย single quote สำหรับ shell ฝั่งมือถือ"""
    return "'" + str(s).replace("'", "'\\''") + "'"


def human_size(n):
    if n is None:
        return ""
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024.0


DATE_RE = re.compile(r"\s(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s(.*)$")


def parse_ls(out):
    """แยกผลลัพธ์ ls -la (รองรับทั้ง toybox และ toolbox) โดยอิงตำแหน่งวันที่"""
    items = []
    for line in out.splitlines():
        line = line.rstrip("\r")
        if not line or line.startswith("total"):
            continue
        m = DATE_RE.search(line)
        if not m:
            continue
        perms = line.split()[0]
        head = line[:m.start()].split()
        size = head[-1] if len(head) > 1 and head[-1].isdigit() else ""
        name, link = m.group(3), ""
        if perms.startswith("l") and " -> " in name:
            name, link = name.split(" -> ", 1)
        if name in (".", ".."):
            continue
        kind = "dir" if perms.startswith("d") else "link" if perms.startswith("l") else "file"
        items.append({"name": name, "kind": kind, "link": link, "perms": perms,
                      "size": int(size) if size and kind == "file" else None,
                      "date": f"{m.group(1)} {m.group(2)}"})
    items.sort(key=lambda i: (i["kind"] == "file", i["name"].lower()))
    return items


def parse_devices(out):
    devs = {}
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 2:
            continue
        serial, state = parts[0], parts[1]
        info = dict(p.split(":", 1) for p in parts[2:] if ":" in p)
        devs[serial] = {"state": state, "model": info.get("model", "").replace("_", " "),
                        "usb": "usb" in info}
    return devs


def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3]) or (0,)


def load_settings():
    s = dict(DEFAULT_SETTINGS)
    try:
        with open(CONF_FILE, "r", encoding="utf-8") as f:
            s.update(json.load(f))
    except (OSError, ValueError):
        pass
    return s


def save_settings(s):
    try:
        os.makedirs(CONF_DIR, exist_ok=True)
        with open(CONF_FILE, "w", encoding="utf-8") as f:
            json.dump(s, f, ensure_ascii=False, indent=2)
    except OSError:
        pass


def open_in_explorer(path):
    try:
        if IS_WIN:
            os.startfile(path)
        else:
            subprocess.Popen(["xdg-open", path])
    except OSError:
        pass


# ----------------------------------------------------------------- adb wrapper
class AdbError(Exception):
    pass


class Adb:
    def __init__(self, path):
        self.path = path
        self.serial = None

    def _cmd(self, args, use_serial=True):
        cmd = [self.path]
        if use_serial and self.serial:
            cmd += ["-s", self.serial]
        return cmd + [str(a) for a in args]

    def run(self, *args, use_serial=True, timeout=30, binary=False, check=False):
        try:
            r = subprocess.run(self._cmd(args, use_serial), capture_output=True,
                               timeout=timeout, creationflags=NO_WINDOW)
        except subprocess.TimeoutExpired:
            raise AdbError("คำสั่งใช้เวลานานเกินไป (timeout)")
        except OSError as e:
            raise AdbError(f"เรียก adb ไม่ได้: {e}")
        if binary:
            return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace")
        out = r.stdout.decode("utf-8", "replace").replace("\r\n", "\n")
        err = r.stderr.decode("utf-8", "replace").replace("\r\n", "\n")
        if check and r.returncode != 0:
            raise AdbError((err or out).strip() or f"adb exit {r.returncode}")
        return r.returncode, out, err

    def shell(self, command, timeout=30, check=False):
        return self.run("shell", command, timeout=timeout, check=check)

    def sh_out(self, command, timeout=30):
        return self.shell(command, timeout=timeout)[1].strip()

    def popen(self, *args, **kw):
        return subprocess.Popen(self._cmd(args), creationflags=NO_WINDOW,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **kw)


# ----------------------------------------------------------------- GUI
class App:
    def __init__(self, root):
        self.root = root
        self.q = queue.Queue()
        self.settings = load_settings()
        self.closing = False
        self.devices = {}
        self.ready = False          # อุปกรณ์ที่เลือกพร้อมใช้งาน (state == device)
        self.scrcpy_proc = None
        self.rec_proc = None
        self.preview_img = None
        self.preview_factor = 1
        self.preview_busy = False
        self.drag_start = None
        self.cwd = "/sdcard"
        self.file_items = []
        self.all_packages = []

        self.adb_path = find_tool("adb")
        self.scrcpy_path = find_tool("scrcpy")
        self.adb = Adb(self.adb_path) if self.adb_path else None

        self._setup_style()
        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)
        self.root.after(80, self._drain)

        self.log(f"adb: {self.adb_path or 'ไม่พบ'}")
        self.log(f"scrcpy: {self.scrcpy_path or 'ไม่พบ'}")
        if not self.adb:
            self.set_status("ไม่พบ adb — กดปุ่ม 'ติดตั้งเครื่องมือ'", "err")
        else:
            threading.Thread(target=self._device_watcher, daemon=True).start()
        self.root.after(4000, lambda: self.check_update(silent=True))

    # ---------- update check (GitHub Releases)
    def check_update(self, silent=True):
        def work():
            import urllib.request
            req = urllib.request.Request(f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
                                         headers={"Accept": "application/vnd.github+json",
                                                  "User-Agent": "GiGoGi-Phone-Control"})
            with urllib.request.urlopen(req, timeout=10) as r:
                data = json.load(r)
            return data.get("tag_name", "").lstrip("v"), data.get("html_url", "")

        def done(res):
            latest, url = res
            if latest and version_tuple(latest) > version_tuple(__version__):
                self.log(f"มีเวอร์ชันใหม่ v{latest} — {url}", "ok")
                if messagebox.askyesno(APP_TITLE, f"มีเวอร์ชันใหม่ v{latest} (ตอนนี้ v{__version__})\nเปิดหน้าดาวน์โหลดไหม?"):
                    import webbrowser
                    webbrowser.open(url)
            elif not silent:
                messagebox.showinfo(APP_TITLE, f"ใช้เวอร์ชันล่าสุดอยู่แล้ว (v{__version__})")

        def runner():
            try:
                res = work()
            except Exception as e:  # noqa: BLE001  ออฟไลน์ หรือยังไม่มี release
                msg = str(e)
                if not silent:
                    self.ui(lambda: messagebox.showwarning(APP_TITLE, f"ตรวจอัปเดตไม่ได้: {msg}"))
                return
            self.ui(lambda: done(res))
        threading.Thread(target=runner, daemon=True).start()

    # ---------- threading helpers
    def _drain(self):
        try:
            while True:
                self.q.get_nowait()()
        except queue.Empty:
            pass
        if not self.closing:
            self.root.after(80, self._drain)

    def ui(self, fn):
        self.q.put(fn)

    def bg(self, work, done=None, label=None):
        """รันงานใน thread แล้วเรียก done(result) บน UI thread"""
        if label:
            self.log(label + " ...")

        def runner():
            try:
                res = work()
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                self.ui(lambda: self.report_error(msg))
                return
            if done:
                self.ui(lambda: done(res))
        threading.Thread(target=runner, daemon=True).start()

    def report_error(self, msg):
        self.log("ผิดพลาด: " + msg, "err")
        if "INJECT_EVENTS" in msg:
            messagebox.showwarning(APP_TITLE, "มือถือไม่อนุญาตให้สั่งแตะ/กดปุ่ม\n\n"
                                   "Xiaomi/POCO/Redmi: เปิด 'USB debugging (Security settings)'\n"
                                   "ในตัวเลือกสำหรับนักพัฒนา แล้วลองใหม่")

    # ---------- style / layout
    def _setup_style(self):
        self.root.title(f"{APP_TITLE}  v{__version__}")
        self.root.geometry("1100x760")
        self.root.minsize(900, 600)
        for f in ("TkDefaultFont", "TkTextFont", "TkMenuFont", "TkHeadingFont"):
            try:
                tk.font.nametofont(f).configure(family=FONT, size=10)
            except tk.TclError:
                pass
        st = ttk.Style()
        st.configure("Status.TLabel", font=(FONT, 10, "bold"))
        st.configure("Big.TButton", font=(FONT, 11, "bold"), padding=8)
        st.configure("Treeview", rowheight=24)

    def _build_ui(self):
        top = ttk.Frame(self.root, padding=(10, 8))
        top.pack(fill="x")
        ttk.Label(top, text="อุปกรณ์:").pack(side="left")
        self.dev_var = tk.StringVar()
        self.dev_combo = ttk.Combobox(top, textvariable=self.dev_var, state="readonly", width=38)
        self.dev_combo.pack(side="left", padx=6)
        self.dev_combo.bind("<<ComboboxSelected>>", lambda e: self.on_device_selected())
        self.status_var = tk.StringVar(value="กำลังเริ่ม...")
        self.status_lbl = ttk.Label(top, textvariable=self.status_var, style="Status.TLabel")
        self.status_lbl.pack(side="left", padx=10)

        ttk.Button(top, text="ตรวจอัปเดต", command=lambda: self.check_update(silent=False)).pack(side="right", padx=2)
        ttk.Button(top, text="วิธีเชื่อมต่อ", command=self.show_help).pack(side="right", padx=2)
        rb = ttk.Menubutton(top, text="รีบูต ▾")
        m = tk.Menu(rb, tearoff=False)
        m.add_command(label="รีสตาร์ทมือถือ", command=lambda: self.reboot(""))
        m.add_command(label="เข้า Recovery", command=lambda: self.reboot("recovery"))
        m.add_command(label="เข้า Bootloader", command=lambda: self.reboot("bootloader"))
        rb["menu"] = m
        rb.pack(side="right", padx=2)
        ttk.Button(top, text="ใช้ผ่าน Wi‑Fi", command=self.enable_wifi).pack(side="right", padx=2)
        ttk.Button(top, text="รีสตาร์ท adb", command=self.restart_adb).pack(side="right", padx=2)
        if not self.adb_path or not self.scrcpy_path:
            ttk.Button(top, text="ติดตั้งเครื่องมือ", command=self.install_tools).pack(side="right", padx=2)

        body = ttk.PanedWindow(self.root, orient="vertical")
        body.pack(fill="both", expand=True, padx=10)
        self.nb = ttk.Notebook(body)
        body.add(self.nb, weight=5)
        self._tab_overview()
        self._tab_screen()
        self._tab_files()
        self._tab_apps()
        self._tab_shell()
        self.nb.bind("<<NotebookTabChanged>>", lambda e: self.on_tab_changed())

        logf = ttk.Frame(body)
        body.add(logf, weight=1)
        self.log_text = tk.Text(logf, height=6, wrap="word", font=("Consolas", 9), state="disabled")
        sb = ttk.Scrollbar(logf, command=self.log_text.yview)
        self.log_text["yscrollcommand"] = sb.set
        sb.pack(side="right", fill="y")
        self.log_text.pack(fill="both", expand=True, pady=(4, 8))
        self.log_text.tag_configure("err", foreground="#c62828")
        self.log_text.tag_configure("ok", foreground="#2e7d32")

    # ---------- tab: overview
    def _tab_overview(self):
        f = ttk.Frame(self.nb, padding=14)
        self.nb.add(f, text="  ภาพรวม  ")
        left = ttk.LabelFrame(f, text="ข้อมูลเครื่อง", padding=12)
        left.pack(side="left", fill="both", expand=True)
        self.info_vars = {}
        rows = [("brand", "ยี่ห้อ"), ("model", "รุ่น"), ("android", "Android"),
                ("serial", "Serial"), ("battery", "แบตเตอรี่"), ("temp", "อุณหภูมิแบต"),
                ("charging", "การชาร์จ"), ("storage", "พื้นที่ (/data)"), ("screen", "หน้าจอ"),
                ("ip", "IP (Wi‑Fi)"), ("uptime", "เปิดเครื่องมา")]
        for i, (k, label) in enumerate(rows):
            ttk.Label(left, text=label + ":").grid(row=i, column=0, sticky="w", pady=3)
            v = tk.StringVar(value="-")
            ttk.Label(left, textvariable=v, font=(FONT, 10, "bold")).grid(row=i, column=1, sticky="w", padx=12)
            self.info_vars[k] = v
        self.bat_bar = ttk.Progressbar(left, length=220, maximum=100)
        self.bat_bar.grid(row=4, column=2, sticky="w")
        ttk.Button(left, text="รีเฟรชข้อมูล", command=self.load_info).grid(row=len(rows), column=0, pady=12, sticky="w")

        right = ttk.LabelFrame(f, text="ทางลัด", padding=12)
        right.pack(side="left", fill="y", padx=(12, 0))
        ttk.Button(right, text="▶  เปิดหน้าจอมือถือ (จอสด)", style="Big.TButton",
                   command=self.start_scrcpy).pack(fill="x", pady=4)
        ttk.Button(right, text="📷  แคปหน้าจอ", style="Big.TButton",
                   command=self.screenshot).pack(fill="x", pady=4)
        ttk.Button(right, text="📁  เปิดโฟลเดอร์รูป/วิดีโอ", style="Big.TButton",
                   command=lambda: (os.makedirs(OUT_PICTURES, exist_ok=True), open_in_explorer(OUT_PICTURES))).pack(fill="x", pady=4)
        self.auto_var = tk.BooleanVar(value=self.settings["auto_mirror"])
        ttk.Checkbutton(right, text="เปิดจอสดอัตโนมัติเมื่อเสียบมือถือ", variable=self.auto_var,
                        command=self._save_opts).pack(anchor="w", pady=(16, 0))

    # ---------- tab: screen & control
    def _tab_screen(self):
        f = ttk.Frame(self.nb, padding=10)
        self.nb.add(f, text="  หน้าจอ & ควบคุม  ")

        left = ttk.Frame(f)
        left.pack(side="left", fill="y")
        sc = ttk.LabelFrame(left, text="จอสด (scrcpy)", padding=10)
        sc.pack(fill="x")
        ttk.Label(sc, text="ความละเอียดสูงสุด").grid(row=0, column=0, sticky="w")
        self.size_var = tk.StringVar(value=self.settings["max_size"])
        ttk.Combobox(sc, textvariable=self.size_var, width=10, state="readonly",
                     values=["เต็ม", "1920", "1600", "1280", "1024", "800"]).grid(row=0, column=1, sticky="w", pady=2)
        ttk.Label(sc, text="บิตเรต").grid(row=1, column=0, sticky="w")
        self.br_var = tk.StringVar(value=self.settings["bitrate"])
        ttk.Combobox(sc, textvariable=self.br_var, width=10, state="readonly",
                     values=["2M", "4M", "8M", "16M", "24M"]).grid(row=1, column=1, sticky="w", pady=2)
        self.opt_vars = {}
        opts = [("stay_awake", "ไม่ให้มือถือจอดับ"), ("screen_off", "ปิดจอมือถือ (ยังคุมได้)"),
                ("on_top", "หน้าต่างอยู่บนสุด"), ("show_touches", "แสดงจุดแตะ"),
                ("no_audio", "ไม่ส่งเสียงมาคอม"), ("fullscreen", "เต็มจอ"),
                ("record", "อัดวิดีโอระหว่างเปิดจอสด")]
        for i, (k, label) in enumerate(opts):
            v = tk.BooleanVar(value=self.settings[k])
            ttk.Checkbutton(sc, text=label, variable=v, command=self._save_opts).grid(
                row=2 + i, column=0, columnspan=2, sticky="w")
            self.opt_vars[k] = v
        bf = ttk.Frame(sc)
        bf.grid(row=10, column=0, columnspan=2, pady=(8, 0), sticky="ew")
        ttk.Button(bf, text="▶ เปิดจอสด", command=self.start_scrcpy).pack(side="left", expand=True, fill="x")
        ttk.Button(bf, text="■ ปิด", command=self.stop_scrcpy).pack(side="left", padx=(4, 0))

        keys = ttk.LabelFrame(left, text="ปุ่มมือถือ", padding=10)
        keys.pack(fill="x", pady=8)
        buttons = [("◀ Back", "KEYCODE_BACK"), ("● Home", "KEYCODE_HOME"), ("▦ แอพล่าสุด", "KEYCODE_APP_SWITCH"),
                   ("⏻ Power", "KEYCODE_POWER"), ("🔊 เสียง+", "KEYCODE_VOLUME_UP"), ("🔉 เสียง−", "KEYCODE_VOLUME_DOWN"),
                   ("🔇 ปิดเสียง", "KEYCODE_VOLUME_MUTE"), ("☀ ปลุกจอ", "KEYCODE_WAKEUP"), ("☾ ปิดจอ", "KEYCODE_SLEEP"),
                   ("⏯ เล่น/หยุด", "KEYCODE_MEDIA_PLAY_PAUSE"), ("⏭ ถัดไป", "KEYCODE_MEDIA_NEXT"), ("📷 กล้อง", "KEYCODE_CAMERA")]
        for i, (label, code) in enumerate(buttons):
            ttk.Button(keys, text=label, width=11, command=lambda c=code: self.keyevent(c)).grid(
                row=i // 3, column=i % 3, padx=2, pady=2)
        ttk.Button(keys, text="แจ้งเตือน", width=11,
                   command=lambda: self.shell_action("cmd statusbar expand-notifications")).grid(row=4, column=0, padx=2, pady=2)
        ttk.Button(keys, text="ตั้งค่าด่วน", width=11,
                   command=lambda: self.shell_action("cmd statusbar expand-settings")).grid(row=4, column=1, padx=2, pady=2)
        ttk.Button(keys, text="ปลดล็อก↑", width=11,
                   command=self.unlock_swipe).grid(row=4, column=2, padx=2, pady=2)

        tx = ttk.LabelFrame(left, text="พิมพ์ข้อความ / เปิดลิงก์", padding=10)
        tx.pack(fill="x")
        self.text_var = tk.StringVar()
        e = ttk.Entry(tx, textvariable=self.text_var, width=32)
        e.grid(row=0, column=0, columnspan=2, sticky="ew")
        e.bind("<Return>", lambda ev: self.send_text())
        ttk.Button(tx, text="ส่งข้อความ", command=self.send_text).grid(row=1, column=0, sticky="ew", pady=4)
        ttk.Button(tx, text="เปิดเป็นลิงก์", command=self.open_url).grid(row=1, column=1, sticky="ew", pady=4, padx=(4, 0))
        ttk.Button(tx, text="Enter ⏎", command=lambda: self.keyevent("KEYCODE_ENTER")).grid(row=2, column=0, sticky="ew")
        ttk.Button(tx, text="ลบ ⌫", command=lambda: self.keyevent("KEYCODE_DEL")).grid(row=2, column=1, sticky="ew", padx=(4, 0))

        right = ttk.LabelFrame(f, text="พรีวิวหน้าจอ — คลิก = แตะ, ลาก = ปัด, คลิกขวา = Back", padding=8)
        right.pack(side="left", fill="both", expand=True, padx=(10, 0))
        bar = ttk.Frame(right)
        bar.pack(fill="x")
        ttk.Button(bar, text="โหลดภาพ", command=self.refresh_preview).pack(side="left")
        self.live_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(bar, text="อัปเดตอัตโนมัติ", variable=self.live_var,
                        command=self._live_loop).pack(side="left", padx=8)
        ttk.Button(bar, text="📷 แคปจอ (บันทึก)", command=self.screenshot).pack(side="left")
        self.rec_btn = ttk.Button(bar, text="⏺ อัดหน้าจอ", command=self.toggle_screenrecord)
        self.rec_btn.pack(side="left", padx=4)
        self.canvas = tk.Canvas(right, bg="#202124", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True, pady=(6, 0))
        self.canvas.create_text(10, 10, anchor="nw", fill="#bbbbbb", font=(FONT, 11),
                                text="กด 'โหลดภาพ' เพื่อดูหน้าจอมือถือ\n(แนะนำใช้ 'เปิดจอสด' เพื่อความลื่นไหล)",
                                tags="hint")
        self.canvas.bind("<ButtonPress-1>", self._on_press)
        self.canvas.bind("<ButtonRelease-1>", self._on_release)
        self.canvas.bind("<Button-3>", lambda e: self.keyevent("KEYCODE_BACK"))

    # ---------- tab: files
    def _tab_files(self):
        f = ttk.Frame(self.nb, padding=10)
        self.nb.add(f, text="  ไฟล์  ")
        nav = ttk.Frame(f)
        nav.pack(fill="x")
        ttk.Button(nav, text="⬆ ขึ้น", command=self.files_up).pack(side="left")
        self.path_var = tk.StringVar(value=self.cwd)
        pe = ttk.Entry(nav, textvariable=self.path_var)
        pe.pack(side="left", fill="x", expand=True, padx=6)
        pe.bind("<Return>", lambda e: self.list_files(self.path_var.get()))
        ttk.Button(nav, text="ไป", command=lambda: self.list_files(self.path_var.get())).pack(side="left")
        ttk.Button(nav, text="↻", width=3, command=lambda: self.list_files(self.cwd)).pack(side="left", padx=(4, 0))

        quick = ttk.Frame(f)
        quick.pack(fill="x", pady=6)
        for label, p in (("ที่เก็บข้อมูล", "/sdcard"), ("รูปกล้อง", "/sdcard/DCIM"), ("ดาวน์โหลด", "/sdcard/Download"),
                         ("รูปภาพ", "/sdcard/Pictures"), ("เพลง", "/sdcard/Music"), ("เอกสาร", "/sdcard/Documents"),
                         ("ภาพหน้าจอ", "/sdcard/Pictures/Screenshots"), ("ราก /", "/")):
            ttk.Button(quick, text=label, command=lambda x=p: self.list_files(x)).pack(side="left", padx=(0, 4))

        mid = ttk.Frame(f)
        mid.pack(fill="both", expand=True)
        cols = ("size", "date")
        self.ftree = ttk.Treeview(mid, columns=cols, selectmode="extended")
        self.ftree.heading("#0", text="ชื่อ")
        self.ftree.heading("size", text="ขนาด")
        self.ftree.heading("date", text="แก้ไขล่าสุด")
        self.ftree.column("#0", width=480)
        self.ftree.column("size", width=100, anchor="e")
        self.ftree.column("date", width=150, anchor="center")
        sb = ttk.Scrollbar(mid, command=self.ftree.yview)
        self.ftree["yscrollcommand"] = sb.set
        sb.pack(side="right", fill="y")
        self.ftree.pack(fill="both", expand=True)
        self.ftree.bind("<Double-1>", lambda e: self.files_open())
        self.ftree.bind("<Delete>", lambda e: self.files_delete())

        act = ttk.Frame(f)
        act.pack(fill="x", pady=(8, 0))
        for label, cmd in (("⬆ อัปโหลดไฟล์", self.files_upload), ("⬆ อัปโหลดโฟลเดอร์", self.files_upload_dir),
                           ("⬇ ดาวน์โหลด", self.files_download), ("📁+ โฟลเดอร์ใหม่", self.files_mkdir),
                           ("✎ เปลี่ยนชื่อ", self.files_rename), ("🗑 ลบ", self.files_delete)):
            ttk.Button(act, text=label, command=cmd).pack(side="left", padx=(0, 4))
        self.files_info = tk.StringVar()
        ttk.Label(act, textvariable=self.files_info).pack(side="right")

    # ---------- tab: apps
    def _tab_apps(self):
        f = ttk.Frame(self.nb, padding=10)
        self.nb.add(f, text="  แอพ  ")
        bar = ttk.Frame(f)
        bar.pack(fill="x")
        ttk.Label(bar, text="ค้นหา:").pack(side="left")
        self.app_filter = tk.StringVar()
        self.app_filter.trace_add("write", lambda *a: self._fill_apps())
        ttk.Entry(bar, textvariable=self.app_filter, width=30).pack(side="left", padx=6)
        self.sys_var = tk.BooleanVar(value=self.settings["show_system_apps"])
        ttk.Checkbutton(bar, text="แสดงแอพระบบ", variable=self.sys_var,
                        command=lambda: (self._save_opts(), self.list_apps())).pack(side="left")
        ttk.Button(bar, text="↻ รีเฟรช", command=self.list_apps).pack(side="left", padx=6)
        self.apps_info = tk.StringVar()
        ttk.Label(bar, textvariable=self.apps_info).pack(side="right")

        mid = ttk.Frame(f)
        mid.pack(fill="both", expand=True, pady=6)
        self.atree = ttk.Treeview(mid, columns=("type",), selectmode="extended")
        self.atree.heading("#0", text="ชื่อแพ็กเกจ")
        self.atree.heading("type", text="ประเภท")
        self.atree.column("#0", width=520)
        self.atree.column("type", width=100, anchor="center")
        sb = ttk.Scrollbar(mid, command=self.atree.yview)
        self.atree["yscrollcommand"] = sb.set
        sb.pack(side="right", fill="y")
        self.atree.pack(fill="both", expand=True)
        self.atree.bind("<Double-1>", lambda e: self.app_launch())

        act = ttk.Frame(f)
        act.pack(fill="x")
        for label, cmd in (("📦 ติดตั้ง APK", self.app_install), ("▶ เปิด", self.app_launch),
                           ("■ บังคับหยุด", self.app_stop), ("ℹ ข้อมูล", self.app_info),
                           ("⬇ ดึง APK", self.app_pull), ("🧹 ล้างข้อมูล", self.app_clear),
                           ("🗑 ถอนการติดตั้ง", self.app_uninstall)):
            ttk.Button(act, text=label, command=cmd).pack(side="left", padx=(0, 4))

    # ---------- tab: shell
    def _tab_shell(self):
        f = ttk.Frame(self.nb, padding=10)
        self.nb.add(f, text="  เทอร์มินัล  ")
        bar = ttk.Frame(f)
        bar.pack(fill="x")
        ttk.Label(bar, text="adb shell $").pack(side="left")
        self.cmd_var = tk.StringVar()
        ce = ttk.Entry(bar, textvariable=self.cmd_var, font=("Consolas", 10))
        ce.pack(side="left", fill="x", expand=True, padx=6)
        ce.bind("<Return>", lambda e: self.run_shell())
        ce.bind("<Up>", lambda e: self._hist(-1))
        ce.bind("<Down>", lambda e: self._hist(1))
        ttk.Button(bar, text="รัน", command=self.run_shell).pack(side="left")
        ttk.Button(bar, text="ล้าง", command=lambda: self.sh_out.delete("1.0", "end")).pack(side="left", padx=4)
        quick = ttk.Frame(f)
        quick.pack(fill="x", pady=6)
        for c in ("getprop ro.product.model", "dumpsys battery", "df -h", "top -n 1 -b | head -20",
                  "pm list users", "settings list global | head -30", "logcat -d -t 50"):
            ttk.Button(quick, text=c.split(" ")[0] if len(c) > 22 else c,
                       command=lambda x=c: (self.cmd_var.set(x), self.run_shell())).pack(side="left", padx=(0, 4))
        self.sh_out = tk.Text(f, wrap="none", font=("Consolas", 10), bg="#1e1e1e", fg="#d4d4d4",
                              insertbackground="white")
        sb = ttk.Scrollbar(f, command=self.sh_out.yview)
        self.sh_out["yscrollcommand"] = sb.set
        sb.pack(side="right", fill="y")
        self.sh_out.pack(fill="both", expand=True)
        self.history, self.hist_i = [], 0

    # ================================================================ logic
    def log(self, msg, tag=None):
        ts = datetime.datetime.now().strftime("%H:%M:%S")
        self.log_text.configure(state="normal")
        self.log_text.insert("end", f"[{ts}] {msg}\n", tag or ())
        self.log_text.see("end")
        self.log_text.configure(state="disabled")

    def set_status(self, text, level="info"):
        colors = {"ok": "#2e7d32", "warn": "#e65100", "err": "#c62828", "info": "#455a64"}
        self.status_var.set(text)
        self.status_lbl.configure(foreground=colors.get(level, "#455a64"))

    def _save_opts(self):
        self.settings["auto_mirror"] = self.auto_var.get()
        self.settings["max_size"] = self.size_var.get()
        self.settings["bitrate"] = self.br_var.get()
        self.settings["show_system_apps"] = self.sys_var.get()
        for k, v in self.opt_vars.items():
            self.settings[k] = v.get()
        save_settings(self.settings)

    def need(self):
        if not self.adb:
            messagebox.showwarning(APP_TITLE, "ยังไม่พบ adb กรุณากด 'ติดตั้งเครื่องมือ'")
            return False
        if not self.ready:
            messagebox.showinfo(APP_TITLE, "ยังไม่มีมือถือที่พร้อมใช้งาน\nเสียบสาย USB และเปิด USB debugging ก่อน\n(ดูปุ่ม 'วิธีเชื่อมต่อ')")
            return False
        return True

    # ---------- device detection
    def _device_watcher(self):
        try:
            self.adb.run("start-server", use_serial=False, timeout=30)
        except AdbError as e:
            msg = str(e)
            self.ui(lambda: self.log("เริ่ม adb server ไม่ได้: " + msg, "err"))
        last = None
        while not self.closing:
            try:
                _, out, _ = self.adb.run("devices", "-l", use_serial=False, timeout=15)
                devs = parse_devices(out)
            except AdbError:
                devs = None
            if devs is not None and devs != last:
                last = devs
                self.ui(lambda d=devs: self._update_devices(d))
            time.sleep(1.5)

    def _update_devices(self, devs):
        old = self.devices
        self.devices = devs
        for s, d in devs.items():
            if s not in old:
                self.log(f"เสียบอุปกรณ์: {d['model'] or s} ({d['state']})", "ok")
            elif old[s]["state"] != d["state"]:
                self.log(f"{d['model'] or s}: สถานะ {old[s]['state']} → {d['state']}")
        for s in old:
            if s not in devs:
                self.log(f"ถอดอุปกรณ์: {old[s]['model'] or s}", "err")
        labels = [self._dev_label(s) for s in devs]
        self.dev_combo["values"] = labels
        cur = self.adb.serial
        if cur not in devs:
            ready = [s for s, d in devs.items() if d["state"] == "device"]
            cur = ready[0] if ready else (next(iter(devs)) if devs else None)
        if cur:
            self.dev_var.set(self._dev_label(cur))
        else:
            self.dev_var.set("")
        self._select(cur)

    def _dev_label(self, serial):
        d = self.devices.get(serial, {})
        conn = "USB" if d.get("usb") else ("Wi‑Fi" if ":" in serial else "")
        return f"{d.get('model') or 'Android'}  [{serial}]  {conn}"

    def on_device_selected(self):
        label = self.dev_var.get()
        for s in self.devices:
            if self._dev_label(s) == label:
                self._select(s, force=True)

    def _select(self, serial, force=False):
        was_ready, prev = self.ready, self.adb.serial
        self.adb.serial = serial
        state = self.devices.get(serial, {}).get("state") if serial else None
        self.ready = state == "device"
        if not serial:
            self.set_status("ไม่พบมือถือ — เสียบสาย USB และเปิด USB debugging", "warn")
        elif state == "unauthorized":
            self.set_status("รอการอนุญาต — กด 'อนุญาต' บนหน้าจอมือถือ", "warn")
        elif state == "offline":
            self.set_status("อุปกรณ์ offline — ลองถอดเสียบใหม่ หรือรีสตาร์ท adb", "err")
        elif state == "device":
            self.set_status(f"เชื่อมต่อแล้ว: {self.devices[serial]['model'] or serial}", "ok")
        else:
            self.set_status(f"สถานะ: {state}", "warn")
        if self.ready and (force or not was_ready or prev != serial):
            self.on_connected(newly=not was_ready or prev != serial)
        if not self.ready:
            for v in self.info_vars.values():
                v.set("-")

    def on_connected(self, newly=True):
        self.load_info()
        self.cwd = "/sdcard"
        if self.nb.index("current") == 2:
            self.list_files(self.cwd)
        elif self.nb.index("current") == 3:
            self.list_apps()
        if newly and self.auto_var.get() and not self._scrcpy_running():
            self.start_scrcpy()

    def on_tab_changed(self):
        if not self.ready:
            return
        i = self.nb.index("current")
        if i == 2 and not self.ftree.get_children():
            self.list_files(self.cwd)
        elif i == 3 and not self.all_packages:
            self.list_apps()

    def restart_adb(self):
        if not self.adb:
            return

        def work():
            self.adb.run("kill-server", use_serial=False, timeout=15)
            self.adb.run("start-server", use_serial=False, timeout=30)
        self.bg(work, lambda r: self.log("รีสตาร์ท adb แล้ว", "ok"), "กำลังรีสตาร์ท adb")

    def install_tools(self):
        if not shutil.which("winget"):
            messagebox.showerror(APP_TITLE, "ไม่พบ winget\nดาวน์โหลด Platform-Tools และ scrcpy เอง แล้ววางไว้ในโฟลเดอร์ tools\\ ข้างโปรแกรมนี้")
            return
        if not messagebox.askyesno(APP_TITLE, "ติดตั้ง Android Platform-Tools (adb) และ scrcpy ผ่าน winget?"):
            return

        def work():
            out = []
            for pkg in ("Google.PlatformTools", "Genymobile.scrcpy"):
                r = subprocess.run(["winget", "install", "--id", pkg, "-e", "--accept-source-agreements",
                                    "--accept-package-agreements", "--disable-interactivity"],
                                   capture_output=True, creationflags=NO_WINDOW)
                out.append(f"{pkg}: exit {r.returncode}")
            return out

        def done(out):
            for o in out:
                self.log(o)
            self.adb_path, self.scrcpy_path = find_tool("adb"), find_tool("scrcpy")
            if self.adb_path and not self.adb:
                self.adb = Adb(self.adb_path)
                threading.Thread(target=self._device_watcher, daemon=True).start()
            self.log(f"adb: {self.adb_path or 'ไม่พบ'} | scrcpy: {self.scrcpy_path or 'ไม่พบ'}", "ok")
        self.bg(work, done, "กำลังติดตั้งเครื่องมือ (อาจใช้เวลา 1-2 นาที)")

    # ---------- overview info
    def load_info(self):
        if not self.ready:
            return
        a = self.adb

        def work():
            info = {}
            props = a.sh_out("getprop ro.product.manufacturer; getprop ro.product.model; "
                             "getprop ro.build.version.release; getprop ro.build.version.sdk")
            p = (props.splitlines() + ["", "", "", ""])[:4]
            info["brand"], info["model"] = p[0], p[1]
            info["android"] = f"{p[2]} (API {p[3]})"
            info["serial"] = a.serial
            bat = a.sh_out("dumpsys battery")
            def g(key):
                m = re.search(rf"^\s*{key}:\s*(.+)$", bat, re.M)
                return m.group(1).strip() if m else ""
            info["battery_level"] = int(g("level") or 0)
            info["battery"] = f"{g('level')}%"
            t = g("temperature")
            info["temp"] = f"{int(t) / 10:.1f} °C" if t.isdigit() else "-"
            src = [n for k, n in (("AC powered", "ไฟบ้าน"), ("USB powered", "USB"), ("Wireless powered", "ไร้สาย"))
                   if g(k) == "true"]
            status = {"2": "กำลังชาร์จ", "3": "ไม่ได้ชาร์จ", "4": "ไม่ได้ชาร์จ", "5": "เต็ม"}.get(g("status"), "-")
            info["charging"] = status + (f" ({', '.join(src)})" if src else "")
            df = a.sh_out("df -h /data | tail -1").split()
            info["storage"] = f"ใช้ {df[2]} / {df[1]} (เหลือ {df[3]})" if len(df) >= 4 else "-"
            size = a.sh_out("wm size").split(":")[-1].strip().replace("\n", " ")
            dens = a.sh_out("wm density").split(":")[-1].strip()
            info["screen"] = f"{size}  •  {dens} dpi"
            ipo = a.sh_out("ip -f inet addr show wlan0")
            m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", ipo)
            info["ip"] = m.group(1) if m else "ไม่ได้ต่อ Wi‑Fi"
            up = a.sh_out("cat /proc/uptime").split()
            if up:
                secs = int(float(up[0]))
                info["uptime"] = f"{secs // 86400} วัน {secs % 86400 // 3600} ชม. {secs % 3600 // 60} นาที"
            return info

        def done(info):
            for k, v in self.info_vars.items():
                v.set(info.get(k) or "-")
            self.bat_bar["value"] = info.get("battery_level", 0)
        self.bg(work, done)

    # ---------- scrcpy
    def _scrcpy_running(self):
        return self.scrcpy_proc is not None and self.scrcpy_proc.poll() is None

    def start_scrcpy(self):
        if not self.need():
            return
        if not self.scrcpy_path:
            messagebox.showwarning(APP_TITLE, "ไม่พบ scrcpy กรุณากด 'ติดตั้งเครื่องมือ'")
            return
        if self._scrcpy_running():
            self.log("จอสดเปิดอยู่แล้ว")
            return
        self._save_opts()
        s = self.settings
        model = self.devices.get(self.adb.serial, {}).get("model") or "Android"
        args = [self.scrcpy_path, "-s", self.adb.serial, "--window-title", f"{model} — {APP_TITLE}",
                "--video-bit-rate", s["bitrate"]]
        if s["max_size"].isdigit():
            args += ["--max-size", s["max_size"]]
        flags = {"stay_awake": "--stay-awake", "screen_off": "--turn-screen-off", "on_top": "--always-on-top",
                 "show_touches": "--show-touches", "no_audio": "--no-audio", "fullscreen": "--fullscreen"}
        args += [f for k, f in flags.items() if s[k]]
        if s["record"]:
            os.makedirs(OUT_VIDEOS, exist_ok=True)
            rec = os.path.join(OUT_VIDEOS, f"scrcpy_{datetime.datetime.now():%Y%m%d_%H%M%S}.mp4")
            args += ["--record", rec]
            self.log(f"อัดวิดีโอไปที่ {rec}")
        env = os.environ.copy()
        env["ADB"] = self.adb_path  # ใช้ adb ตัวเดียวกัน กัน server เวอร์ชันชนกัน
        try:
            self.scrcpy_proc = subprocess.Popen(args, env=env, cwd=os.path.dirname(self.scrcpy_path),
                                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                                creationflags=NO_WINDOW)
        except OSError as e:
            self.report_error(f"เปิด scrcpy ไม่ได้: {e}")
            return
        self.log("เปิดจอสดแล้ว", "ok")
        proc = self.scrcpy_proc

        def reader():
            tail = []
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                tail = (tail + [line])[-15:]
                if line.startswith(("ERROR", "WARN")):
                    self.ui(lambda l=line: self.log("scrcpy: " + l, "err" if l.startswith("ERROR") else None))
            code = proc.wait()
            if code not in (0, None) and not self.closing:
                msg = "\n".join(tail)
                self.ui(lambda: self._scrcpy_failed(code, msg))
            else:
                self.ui(lambda: self.log("ปิดจอสดแล้ว"))
        threading.Thread(target=reader, daemon=True).start()

    def _scrcpy_failed(self, code, msg):
        self.log(f"scrcpy ปิดตัวผิดปกติ (code {code})", "err")
        hint = ""
        if "INJECT_EVENTS" in msg:
            hint = "\n\nXiaomi/POCO: เปิด 'USB debugging (Security settings)'"
        elif "audio" in msg.lower():
            hint = "\n\nลองติ๊ก 'ไม่ส่งเสียงมาคอม' แล้วเปิดใหม่"
        elif "encoder" in msg.lower() or "codec" in msg.lower():
            hint = "\n\nลองลดความละเอียดสูงสุดเป็น 1024 หรือ 800"
        messagebox.showerror(APP_TITLE, f"เปิดจอสดไม่สำเร็จ\n\n{msg[-800:]}{hint}")

    def stop_scrcpy(self):
        if self._scrcpy_running():
            self.scrcpy_proc.terminate()

    # ---------- input
    def keyevent(self, code):
        if not self.need():
            return
        self.bg(lambda: self.adb.shell(f"input keyevent {code}", check=True))

    def shell_action(self, cmd):
        if self.need():
            self.bg(lambda: self.adb.shell(cmd, check=True))

    def unlock_swipe(self):
        if not self.need():
            return

        def work():
            self.adb.shell("input keyevent KEYCODE_WAKEUP", check=True)
            size = self.adb.sh_out("wm size").split(":")[-1].split()[-1:]  # Override ถ้ามี
            w, h = (int(x) for x in size[0].split("x")) if size else (1080, 2400)
            time.sleep(0.3)
            self.adb.shell(f"input swipe {w // 2} {int(h * 0.85)} {w // 2} {int(h * 0.25)} 250", check=True)
        self.bg(work)

    def send_text(self):
        text = self.text_var.get()
        if not text or not self.need():
            return
        if any(ord(c) > 127 for c in text):
            self.root.clipboard_clear()
            self.root.clipboard_append(text)
            if self._scrcpy_running():
                messagebox.showinfo(APP_TITLE, "ข้อความมีภาษาไทย/อักขระพิเศษ คัดลอกลงคลิปบอร์ดแล้ว\n"
                                    "คลิกที่หน้าต่างจอสด แล้วกด Ctrl+V เพื่อวาง")
            else:
                messagebox.showinfo(APP_TITLE, "adb ส่งภาษาไทยตรง ๆ ไม่ได้\n"
                                    "คัดลอกลงคลิปบอร์ดแล้ว — เปิด 'จอสด' แล้วกด Ctrl+V ในหน้าต่างนั้น")
            return
        payload = text.replace(" ", "%s")
        self.bg(lambda: self.adb.shell("input text " + shq(payload), check=True),
                lambda r: self.text_var.set(""))

    def open_url(self):
        url = self.text_var.get().strip()
        if not url or not self.need():
            return
        if not re.match(r"^[a-zA-Z][\w+.-]*:", url):
            url = "https://" + url
        self.bg(lambda: self.adb.shell("am start -a android.intent.action.VIEW -d " + shq(url), check=True),
                lambda r: self.log("เปิดลิงก์: " + url, "ok"))

    # ---------- preview / screenshot
    def _grab_png(self):
        code, data, err = self.adb.run("exec-out", "screencap -p", binary=True, timeout=20)
        if code != 0 or not data.startswith(b"\x89PNG"):
            raise AdbError("แคปหน้าจอไม่ได้ (บางแอพ เช่น แอพธนาคาร ห้ามแคปจอ) " + err.strip())
        return data

    def refresh_preview(self, quiet=False):
        if self.preview_busy:
            return
        if quiet and not self.ready:
            return
        if not quiet and not self.need():
            return
        self.preview_busy = True

        def done(png):
            self.preview_busy = False
            try:
                img = tk.PhotoImage(data=base64.b64encode(png).decode("ascii"))
            except tk.TclError as e:
                self.report_error(f"แสดงภาพไม่ได้: {e}")
                return
            cw = max(self.canvas.winfo_width(), 200)
            ch = max(self.canvas.winfo_height(), 200)
            factor = max(1, -(-img.width() // cw), -(-img.height() // ch))
            self.preview_factor = factor
            self.preview_img = img.subsample(factor) if factor > 1 else img
            self.canvas.delete("all")
            self.canvas.create_image(0, 0, anchor="nw", image=self.preview_img)

        def work():
            try:
                return self._grab_png()
            except Exception:
                self.preview_busy = False
                raise
        self.bg(work, done)

    def _live_loop(self):
        if self.live_var.get() and not self.closing:
            if self.nb.index("current") == 1:
                self.refresh_preview(quiet=True)
            self.root.after(1500, self._live_loop)

    def _on_press(self, e):
        self.drag_start = (e.x, e.y, time.time())

    def _on_release(self, e):
        if not self.drag_start or not self.preview_img or not self.need():
            return
        x0, y0, t0 = self.drag_start
        self.drag_start = None
        f = self.preview_factor
        if abs(e.x - x0) < 8 and abs(e.y - y0) < 8:
            held = time.time() - t0
            cmd = (f"input swipe {x0 * f} {y0 * f} {x0 * f} {y0 * f} 700" if held > 0.6
                   else f"input tap {x0 * f} {y0 * f}")
        else:
            dur = int(min(max((time.time() - t0) * 1000, 100), 2000))
            cmd = f"input swipe {x0 * f} {y0 * f} {e.x * f} {e.y * f} {dur}"

        def work():
            self.adb.shell(cmd, check=True)
            time.sleep(0.5)
        self.bg(work, lambda r: self.refresh_preview(quiet=True))

    def screenshot(self):
        if not self.need():
            return

        def work():
            png = self._grab_png()
            os.makedirs(OUT_PICTURES, exist_ok=True)
            path = os.path.join(OUT_PICTURES, f"screen_{datetime.datetime.now():%Y%m%d_%H%M%S}.png")
            with open(path, "wb") as fh:
                fh.write(png)
            return path
        self.bg(work, lambda p: self.log(f"บันทึกภาพหน้าจอ: {p}", "ok"), "กำลังแคปหน้าจอ")

    def toggle_screenrecord(self):
        if not self.need():
            return
        remote = "/sdcard/_gigogi_rec.mp4"
        if self.rec_proc is None:
            self.rec_proc = self.adb.popen("shell", f"screenrecord --time-limit 180 {remote}")
            self.rec_btn.configure(text="⏹ หยุดอัด")
            self.log("เริ่มอัดหน้าจอ (สูงสุด 3 นาที) — กด 'หยุดอัด' เพื่อบันทึก", "ok")
            proc = self.rec_proc

            def watch():
                proc.wait()
                if self.rec_proc is proc:  # หมดเวลา 3 นาทีเอง
                    self.ui(self.toggle_screenrecord)
            threading.Thread(target=watch, daemon=True).start()
            return
        proc, self.rec_proc = self.rec_proc, None
        self.rec_btn.configure(text="⏺ อัดหน้าจอ")

        def work():
            self.adb.shell("pkill -INT screenrecord")
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
            time.sleep(1.0)  # รอให้ไฟล์ mp4 เขียนเสร็จ
            os.makedirs(OUT_VIDEOS, exist_ok=True)
            local = os.path.join(OUT_VIDEOS, f"record_{datetime.datetime.now():%Y%m%d_%H%M%S}.mp4")
            self.adb.run("pull", remote, local, timeout=300, check=True)
            self.adb.shell(f"rm -f {remote}")
            return local
        self.bg(work, lambda p: self.log(f"บันทึกวิดีโอ: {p}", "ok"), "กำลังบันทึกวิดีโอ")

    # ---------- files
    def list_files(self, path):
        if not self.need():
            return
        path = posixpath.normpath(path.strip() or "/")
        a = self.adb

        def work():
            code, out, err = a.shell(f"ls -la {shq(path.rstrip('/') + '/')}", timeout=30)
            items = parse_ls(out)
            if not items and ("No such file" in out + err or "Permission denied" in out + err or "Not a directory" in out + err):
                raise AdbError((err or out).strip().splitlines()[0])
            return items

        def done(items):
            self.cwd = path
            self.path_var.set(path)
            self.file_items = items
            self.ftree.delete(*self.ftree.get_children())
            icons = {"dir": "📁 ", "link": "🔗 ", "file": "📄 "}
            for i, it in enumerate(items):
                self.ftree.insert("", "end", iid=str(i), text=icons[it["kind"]] + it["name"],
                                  values=(human_size(it["size"]), it["date"]))
            total = sum(it["size"] or 0 for it in items)
            self.files_info.set(f"{len(items)} รายการ • {human_size(total)}")
        self.bg(work, done)

    def _selected_files(self):
        return [self.file_items[int(i)] for i in self.ftree.selection()]

    def files_open(self):
        sel = self._selected_files()
        if not sel:
            return
        it = sel[0]
        if it["kind"] in ("dir", "link"):
            self.list_files(posixpath.join(self.cwd, it["name"]))
        else:
            self.files_download(open_after=True)

    def files_up(self):
        self.list_files(posixpath.dirname(self.cwd.rstrip("/")) or "/")

    def files_upload(self):
        if not self.need():
            return
        paths = filedialog.askopenfilenames(title="เลือกไฟล์ที่จะส่งไปมือถือ")
        if paths:
            self._push(list(paths))

    def files_upload_dir(self):
        if not self.need():
            return
        p = filedialog.askdirectory(title="เลือกโฟลเดอร์ที่จะส่งไปมือถือ")
        if p:
            self._push([p])

    def _push(self, paths):
        dest = self.cwd.rstrip("/") + "/"

        def work():
            for p in paths:
                self.ui(lambda n=os.path.basename(p): self.log(f"กำลังส่ง {n} ..."))
                self.adb.run("push", p, dest, timeout=None, check=True)
            return len(paths)

        def done(n):
            self.log(f"ส่งไปมือถือแล้ว {n} รายการ → {dest}", "ok")
            self.list_files(self.cwd)
        self.bg(work, done)

    def files_download(self, open_after=False):
        if not self.need():
            return
        sel = self._selected_files()
        if not sel:
            messagebox.showinfo(APP_TITLE, "เลือกไฟล์ก่อน")
            return
        if open_after:
            target = os.path.join(HOME, "Downloads", "PhoneControl")
        else:
            target = filedialog.askdirectory(title="บันทึกไปที่โฟลเดอร์")
            if not target:
                return
        os.makedirs(target, exist_ok=True)

        def work():
            for it in sel:
                remote = posixpath.join(self.cwd, it["name"])
                self.ui(lambda n=it["name"]: self.log(f"กำลังดึง {n} ..."))
                self.adb.run("pull", remote, target, timeout=None, check=True)
            return target

        def done(t):
            self.log(f"ดาวน์โหลดแล้ว {len(sel)} รายการ → {t}", "ok")
            if open_after:
                open_in_explorer(os.path.join(t, sel[0]["name"]))
            else:
                open_in_explorer(t)
        self.bg(work, done)

    def files_mkdir(self):
        if not self.need():
            return
        name = simpledialog.askstring(APP_TITLE, "ชื่อโฟลเดอร์ใหม่:", parent=self.root)
        if name:
            p = posixpath.join(self.cwd, name)
            self.bg(lambda: self.adb.shell(f"mkdir -p {shq(p)}", check=True), lambda r: self.list_files(self.cwd))

    def files_rename(self):
        sel = self._selected_files()
        if not sel or not self.need():
            return
        old = sel[0]["name"]
        new = simpledialog.askstring(APP_TITLE, "ชื่อใหม่:", initialvalue=old, parent=self.root)
        if new and new != old:
            a, b = posixpath.join(self.cwd, old), posixpath.join(self.cwd, new)
            self.bg(lambda: self.adb.shell(f"mv {shq(a)} {shq(b)}", check=True), lambda r: self.list_files(self.cwd))

    def files_delete(self):
        sel = self._selected_files()
        if not sel or not self.need():
            return
        names = "\n".join("• " + it["name"] for it in sel[:10]) + ("\n..." if len(sel) > 10 else "")
        if not messagebox.askyesno(APP_TITLE, f"ลบ {len(sel)} รายการนี้ออกจากมือถือถาวร?\n(กู้คืนไม่ได้)\n\n{names}",
                                   icon="warning"):
            return
        targets = " ".join(shq(posixpath.join(self.cwd, it["name"])) for it in sel)
        self.bg(lambda: self.adb.shell(f"rm -rf {targets}", check=True),
                lambda r: (self.log(f"ลบแล้ว {len(sel)} รายการ", "ok"), self.list_files(self.cwd)))

    # ---------- apps
    def list_apps(self):
        if not self.need():
            return
        system = self.sys_var.get()

        def work():
            user = {l.split(":", 1)[1].strip() for l in self.adb.sh_out("pm list packages -3").splitlines() if ":" in l}
            pk = user
            if system:
                pk = {l.split(":", 1)[1].strip() for l in self.adb.sh_out("pm list packages").splitlines() if ":" in l}
            return sorted(pk), user

        def done(res):
            self.all_packages, self.user_packages = res
            self._fill_apps()
        self.bg(work, done)

    def _fill_apps(self):
        if not hasattr(self, "atree"):
            return
        q = self.app_filter.get().lower().strip()
        self.atree.delete(*self.atree.get_children())
        shown = [p for p in self.all_packages if q in p.lower()]
        users = getattr(self, "user_packages", set())
        for p in shown:
            self.atree.insert("", "end", iid=p, text=p, values=("ผู้ใช้" if p in users else "ระบบ",))
        self.apps_info.set(f"แสดง {len(shown)} / {len(self.all_packages)} แอพ")

    def _sel_apps(self, single=False):
        sel = list(self.atree.selection())
        if not sel:
            messagebox.showinfo(APP_TITLE, "เลือกแอพก่อน")
            return []
        return sel[:1] if single else sel

    def app_install(self):
        if not self.need():
            return
        files = filedialog.askopenfilenames(title="เลือกไฟล์ APK", filetypes=[("Android APK", "*.apk"), ("ทุกไฟล์", "*.*")])
        if not files:
            return

        def work():
            res = []
            for fpath in files:
                self.ui(lambda n=os.path.basename(fpath): self.log(f"กำลังติดตั้ง {n} ... (อาจต้องกดยืนยันบนมือถือ)"))
                code, out, err = self.adb.run("install", "-r", fpath, timeout=None)
                ok = "Success" in out
                res.append((os.path.basename(fpath), ok, (out + err).strip().splitlines()[-1:] or [""]))
            return res

        def done(res):
            for name, ok, msg in res:
                self.log(f"{name}: {'ติดตั้งสำเร็จ' if ok else 'ล้มเหลว — ' + msg[0]}", "ok" if ok else "err")
            self.list_apps()
        self.bg(work, done)

    def app_launch(self):
        sel = self.need() and self._sel_apps(single=True)
        if sel:
            p = sel[0]
            self.bg(lambda: self.adb.shell(f"monkey -p {shq(p)} -c android.intent.category.LAUNCHER 1"),
                    lambda r: self.log(f"เปิด {p}" if "No activities" not in r[1] else f"{p} ไม่มีหน้าจอให้เปิด",
                                       "ok" if "No activities" not in r[1] else "err"))

    def app_stop(self):
        sel = self.need() and self._sel_apps()
        if sel:
            self.bg(lambda: [self.adb.shell(f"am force-stop {shq(p)}") for p in sel],
                    lambda r: self.log(f"บังคับหยุด {len(sel)} แอพ", "ok"))

    def app_info(self):
        sel = self.need() and self._sel_apps(single=True)
        if not sel:
            return
        p = sel[0]

        def work():
            d = self.adb.sh_out(f"dumpsys package {shq(p)}", timeout=30)
            def g(k):
                m = re.search(rf"{k}=(\S+)", d)
                return m.group(1) if m else "-"
            path = self.adb.sh_out(f"pm path {shq(p)}").replace("package:", "")
            return (f"แพ็กเกจ: {p}\nเวอร์ชัน: {g('versionName')} (code {g('versionCode')})\n"
                    f"targetSdk: {g('targetSdk')}\nติดตั้งครั้งแรก: {g('firstInstallTime')}\n"
                    f"อัปเดตล่าสุด: {g('lastUpdateTime')}\nที่อยู่ APK:\n{path}")
        self.bg(work, lambda t: messagebox.showinfo(APP_TITLE, t))

    def app_pull(self):
        sel = self.need() and self._sel_apps()
        if not sel:
            return
        target = filedialog.askdirectory(title="บันทึก APK ไปที่")
        if not target:
            return

        def work():
            n = 0
            for p in sel:
                paths = [l.replace("package:", "").strip() for l in self.adb.sh_out(f"pm path {shq(p)}").splitlines() if l]
                for rp in paths:
                    name = f"{p}.apk" if len(paths) == 1 else f"{p}__{posixpath.basename(rp)}"
                    self.adb.run("pull", rp, os.path.join(target, name), timeout=None, check=True)
                    n += 1
            return n
        self.bg(work, lambda n: (self.log(f"ดึง APK แล้ว {n} ไฟล์ → {target}", "ok"), open_in_explorer(target)),
                "กำลังดึง APK")

    def app_clear(self):
        sel = self.need() and self._sel_apps()
        if not sel:
            return
        if not messagebox.askyesno(APP_TITLE, "ล้างข้อมูลแอพเหล่านี้? (การล็อกอิน/ข้อมูลในแอพจะหายถาวร)\n\n" + "\n".join(sel[:10]),
                                   icon="warning"):
            return
        self.bg(lambda: [self.adb.sh_out(f"pm clear {shq(p)}") for p in sel],
                lambda r: self.log("ผลล้างข้อมูล: " + ", ".join(r), "ok"))

    def app_uninstall(self):
        sel = self.need() and self._sel_apps()
        if not sel:
            return
        users = getattr(self, "user_packages", set())
        sysapps = [p for p in sel if p not in users]
        if sysapps:
            messagebox.showwarning(APP_TITLE, "แอพระบบถอนไม่ได้จากโปรแกรมนี้ (เพื่อความปลอดภัยของเครื่อง):\n" + "\n".join(sysapps))
            sel = [p for p in sel if p in users]
            if not sel:
                return
        if not messagebox.askyesno(APP_TITLE, "ถอนการติดตั้งแอพเหล่านี้? (ข้อมูลในแอพจะหาย)\n\n" + "\n".join(sel[:10]),
                                   icon="warning"):
            return

        def work():
            return [(p, self.adb.run("uninstall", p, timeout=120)[1].strip()) for p in sel]

        def done(res):
            for p, out in res:
                self.log(f"{p}: {out}", "ok" if "Success" in out else "err")
            self.list_apps()
        self.bg(work, done)

    # ---------- shell
    def run_shell(self):
        cmd = self.cmd_var.get().strip()
        if not cmd or not self.need():
            return
        self.history.append(cmd)
        self.hist_i = len(self.history)
        self.cmd_var.set("")
        self.sh_out.insert("end", f"$ {cmd}\n")

        def done(r):
            code, out, err = r
            self.sh_out.insert("end", (out + err).rstrip() + f"\n[exit {code}]\n\n")
            self.sh_out.see("end")
        self.bg(lambda: self.adb.shell(cmd, timeout=60), done)

    def _hist(self, d):
        if not self.history:
            return
        self.hist_i = min(max(self.hist_i + d, 0), len(self.history))
        self.cmd_var.set(self.history[self.hist_i] if self.hist_i < len(self.history) else "")

    # ---------- misc
    def reboot(self, mode):
        if not self.need():
            return
        names = {"": "รีสตาร์ทมือถือ", "recovery": "รีบูตเข้า Recovery", "bootloader": "รีบูตเข้า Bootloader"}
        if messagebox.askyesno(APP_TITLE, f"{names[mode]} ตอนนี้?", icon="warning"):
            args = ("reboot", mode) if mode else ("reboot",)
            self.bg(lambda: self.adb.run(*args, timeout=30), lambda r: self.log(names[mode], "ok"))

    def enable_wifi(self):
        if not self.need():
            return
        if ":" in (self.adb.serial or ""):
            messagebox.showinfo(APP_TITLE, "ตอนนี้เชื่อมต่อผ่าน Wi‑Fi อยู่แล้ว")
            return
        if not messagebox.askyesno(APP_TITLE, "เปิดการเชื่อมต่อผ่าน Wi‑Fi?\n\nมือถือกับคอมต้องอยู่ Wi‑Fi เดียวกัน\n"
                                   "หลังเชื่อมต่อสำเร็จ ถอดสาย USB ได้ (ใช้ได้จนกว่ามือถือจะรีสตาร์ท)"):
            return

        def work():
            ipo = self.adb.sh_out("ip -f inet addr show wlan0")
            m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", ipo)
            if not m:
                raise AdbError("มือถือยังไม่ได้ต่อ Wi‑Fi")
            ip = m.group(1)
            self.adb.run("tcpip", "5555", timeout=20, check=True)
            time.sleep(2.5)
            _, out, err = self.adb.run("connect", f"{ip}:5555", use_serial=False, timeout=20)
            return (out + err).strip()
        self.bg(work, lambda r: self.log("Wi‑Fi: " + r, "ok" if "connected" in r else "err"), "กำลังเปิด Wi‑Fi")

    def show_help(self):
        w = tk.Toplevel(self.root)
        w.title("วิธีเชื่อมต่อ")
        w.geometry("640x620")
        t = tk.Text(w, wrap="word", font=(FONT, 10), padx=14, pady=12)
        t.insert("1.0", HELP_TEXT)
        t.configure(state="disabled")
        t.pack(fill="both", expand=True)
        ttk.Button(w, text="ปิด", command=w.destroy).pack(pady=8)

    def on_close(self):
        self.closing = True
        self._save_opts()
        if self.rec_proc:
            try:
                self.adb.shell("pkill -INT screenrecord", timeout=5)
            except AdbError:
                pass
        self.root.destroy()


# ----------------------------------------------------------------- entry
def selftest():
    print("version:", __version__)
    print("adb   :", find_tool("adb"))
    print("scrcpy:", find_tool("scrcpy"))
    adbp = find_tool("adb")
    if adbp:
        a = Adb(adbp)
        print(a.run("version", use_serial=False)[1].splitlines()[0])
        _, out, _ = a.run("devices", "-l", use_serial=False)
        print("devices:", parse_devices(out) or "ไม่มี")
    sample = ("total 24\n"
              "drwxrwx--x 4 root sdcard_rw 3488 2024-01-05 12:00 Android\n"
              "-rw-rw---- 1 u0_a1 sdcard_rw 1048576 2024-02-01 08:15 my file ไทย.jpg\n"
              "lrwxrwxrwx 1 root root 21 2024-01-01 00:00 sdcard -> /storage/self/primary\n"
              "drwxrwx--- root sdcard_r 2019-03-04 10:22 OldStyle\n")
    items = parse_ls(sample)
    assert [i["name"] for i in items] == ["Android", "OldStyle", "sdcard", "my file ไทย.jpg"], items
    assert items[3]["size"] == 1048576 and items[2]["link"] == "/storage/self/primary"
    assert shq("it's") == "'it'\\''s'"
    assert version_tuple("v1.10.0") > version_tuple("1.9.3")
    devs = parse_devices("List of devices attached\nR58M device usb:1-1 product:x model:SM_G973F device:y\nZX unauthorized usb:1-2\n")
    assert devs["R58M"]["model"] == "SM G973F" and devs["ZX"]["state"] == "unauthorized"
    print("parser tests: OK")


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    if IS_WIN:
        try:
            import ctypes
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except (AttributeError, OSError):
            pass
    import tkinter.font  # noqa: F401  (ใช้ใน _setup_style)
    root = tk.Tk()
    app = App(root)
    if "--smoke" in sys.argv:
        def check():
            for i in range(app.nb.index("end")):
                app.nb.select(i)
                root.update()
            print("smoke: UI OK | status =", app.status_var.get())
            app.on_close()
        root.after(3000, check)
    root.mainloop()


if __name__ == "__main__":
    main()
