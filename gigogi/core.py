# -*- coding: utf-8 -*-
"""ส่วนแกน: หาเครื่องมือ, เรียก adb, แยกข้อมูลผลลัพธ์ (ไม่มี UI)"""

import glob
import os
import re
import shutil
import subprocess
import sys

IS_WIN = os.name == "nt"
NO_WINDOW = 0x08000000 if IS_WIN else 0
FROZEN = getattr(sys, "frozen", False)
# โฟลเดอร์ของโปรแกรม (ข้าง .exe หรือรากของซอร์ส)
APP_DIR = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# โฟลเดอร์ไฟล์ประกอบ (ui/) — ใน .exe อยู่ใน _internal
RES_DIR = getattr(sys, "_MEIPASS", APP_DIR)


def registry_path_dirs():
    """PATH จาก Registry (PATH ของโปรเซสอาจเก่า หากติดตั้งเครื่องมือหลังเปิดเครื่อง)"""
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
    # 1) ที่มากับตัวติดตั้ง tools\scrcpy\ — ใช้ก่อนเสมอ เพื่อให้ adb กับ scrcpy เวอร์ชันตรงกัน
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
        if name == "adb":
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


def version_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", v)[:3]) or (0,)


DATE_RE = re.compile(r"\s(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s(.*)$")


def parse_ls(out):
    """แยกผล ls -la (toybox และ toolbox) โดยอิงตำแหน่งวันที่ ไม่นับคอลัมน์"""
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
        items.append({"name": name, "kind": kind, "link": link,
                      "size": int(size) if size and kind == "file" else None,
                      "date": f"{m.group(1)} {m.group(2)}"})
    items.sort(key=lambda i: (i["kind"] == "file", i["name"].lower()))
    return items


def parse_devices(out):
    devs = {}
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) < 2 or parts[0].startswith("*"):
            continue
        serial, state = parts[0], parts[1]
        info = dict(p.split(":", 1) for p in parts[2:] if ":" in p)
        devs[serial] = {"serial": serial, "state": state,
                        "model": info.get("model", "").replace("_", " "),
                        "transport": "usb" if "usb" in info else ("wifi" if ":" in serial or "._adb-tls" in serial else "other")}
    return devs


def parse_kv(text, sep=":"):
    out = {}
    for line in text.splitlines():
        if sep in line:
            k, v = line.split(sep, 1)
            out[k.strip()] = v.strip()
    return out


def parse_wm_size(text):
    """คืน (w, h) — ใช้ Override size ถ้ามี"""
    found = dict(re.findall(r"(Physical|Override) size:\s*(\d+x\d+)", text))
    val = found.get("Override") or found.get("Physical")
    if not val:
        return None
    w, h = val.split("x")
    return int(w), int(h)


class AdbError(Exception):
    pass


INJECT_HINT = ("มือถือไม่อนุญาตให้คอมสั่งแตะหรือกดปุ่ม — ถ้าเป็น Xiaomi, POCO หรือ Redmi "
               "ให้เปิด 'USB debugging (Security settings)' ในตัวเลือกสำหรับนักพัฒนา")


def friendly_error(text):
    t = text.strip()
    if "INJECT_EVENTS" in t:
        return INJECT_HINT
    if "unauthorized" in t:
        return "มือถือยังไม่อนุญาต — กด 'อนุญาต' บนหน้าจอมือถือ"
    if "device offline" in t:
        return "มือถือขาดการเชื่อมต่อ — ลองถอดสายแล้วเสียบใหม่"
    if re.search(r"device '.*' not found|no devices", t):
        return "ไม่พบมือถือ — ตรวจสายแล้วลองอีกครั้ง"
    if "Permission denied" in t:
        return "ไม่มีสิทธิ์เข้าถึงตำแหน่งนี้ในมือถือ"
    if "No such file" in t:
        return "ไม่พบไฟล์หรือโฟลเดอร์นี้ในมือถือ"
    if "No space left" in t:
        return "พื้นที่ปลายทางเต็ม"
    return t.splitlines()[-1] if t else "คำสั่งไม่สำเร็จ"


class Adb:
    def __init__(self, path):
        self.path = path
        self.serial = None

    def cmd(self, args, use_serial=True, serial=None):
        c = [self.path]
        s = serial or (self.serial if use_serial else None)
        if s:
            c += ["-s", s]
        return c + [str(a) for a in args]

    def run(self, *args, use_serial=True, timeout=30, binary=False, check=False, serial=None):
        try:
            r = subprocess.run(self.cmd(args, use_serial, serial), capture_output=True,
                               timeout=timeout, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
        except subprocess.TimeoutExpired:
            raise AdbError("มือถือตอบสนองช้าเกินไป ลองอีกครั้ง")
        except OSError as e:
            raise AdbError(f"เรียก adb ไม่ได้: {e}")
        if binary:
            return r.returncode, r.stdout, r.stderr.decode("utf-8", "replace")
        out = r.stdout.decode("utf-8", "replace").replace("\r\n", "\n")
        err = r.stderr.decode("utf-8", "replace").replace("\r\n", "\n")
        if check and (r.returncode != 0 or "INJECT_EVENTS" in err + out):
            raise AdbError(friendly_error(err or out or f"exit {r.returncode}"))
        return r.returncode, out, err

    def shell(self, command, timeout=30, check=False):
        return self.run("shell", command, timeout=timeout, check=check)

    def sh_out(self, command, timeout=30):
        return self.shell(command, timeout=timeout)[1].strip()

    def popen(self, *args, **kw):
        kw.setdefault("stdout", subprocess.DEVNULL)
        kw.setdefault("stderr", subprocess.DEVNULL)
        return subprocess.Popen(self.cmd(args), creationflags=NO_WINDOW, stdin=subprocess.DEVNULL, **kw)
