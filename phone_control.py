#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
GiGoGi — ควบคุมมือถือ Android จากคอม Windows (adb + scrcpy) หน้าตาเป็น HTML ในหน้าต่าง pywebview

    python phone_control.py              เปิดโปรแกรม
    python phone_control.py --debug      เปิดพร้อมเครื่องมือนักพัฒนา (F12)
    python phone_control.py --selftest   ทดสอบตัวแยกข้อมูลและการหาเครื่องมือ
    python phone_control.py --smoke      เปิดหน้าต่างแล้วตรวจว่าหน้า UI โหลดได้ แล้วปิดเอง
"""

import os
import sys
import threading
import time

from version import __version__
from gigogi.core import (RES_DIR, Adb, find_tool, parse_devices, parse_ls, parse_wm_size,
                         shq, version_tuple, friendly_error)


def _print(*a):
    if sys.stdout:  # .exe แบบไม่มีหน้าต่าง console จะไม่มี stdout
        print(*a, flush=True)


def selftest():
    _print("version:", __version__)
    _print("adb   :", find_tool("adb"))
    _print("scrcpy:", find_tool("scrcpy"))
    adbp = find_tool("adb")
    if adbp:
        a = Adb(adbp)
        _print(a.run("version", use_serial=False)[1].splitlines()[0])
        _print("devices:", parse_devices(a.run("devices", "-l", use_serial=False)[1]) or "ไม่มี")
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
    assert parse_wm_size("Physical size: 1080x2400\nOverride size: 720x1600") == (720, 1600)
    assert parse_wm_size("Physical size: 1080x2400") == (1080, 2400)
    devs = parse_devices("List of devices attached\n* daemon started successfully\n"
                         "R58M device usb:1-1 product:x model:SM_G973F device:y\n"
                         "ZX unauthorized usb:1-2\n192.168.1.5:5555 device product:p model:Pixel_7\n")
    assert devs["R58M"]["model"] == "SM G973F" and devs["ZX"]["state"] == "unauthorized"
    assert devs["192.168.1.5:5555"]["transport"] == "wifi" and devs["R58M"]["transport"] == "usb"
    assert "Xiaomi" in friendly_error("java.lang.SecurityException: Injecting to another application requires INJECT_EVENTS permission")
    from gigogi.api import _to_bytes
    assert _to_bytes("1024") == 1024 * 1024 and _to_bytes("2G") == 2 * 1024 ** 3
    for f in ("index.html", "icon.ico", "scrcpy-icons/scrcpy.png", "scrcpy-icons/disconnected.png"):
        assert os.path.isfile(os.path.join(RES_DIR, "ui", f)), f"ui/{f} missing"
    _print("selftest: OK")


def _app_id():
    """ให้ Windows นับเป็นโปรแกรม GiGoGi บนแถบงาน (ไม่ใช่ python.exe) ต้องเรียกก่อนสร้างหน้าต่าง"""
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("GiGoGi.PhoneControl")
    except (AttributeError, OSError):
        pass


def _set_window_icon(window):
    """ใส่โลโก้ GiGoGi ให้หน้าต่าง (มุมซ้ายบน, Alt+Tab และแถบงาน)"""
    try:
        import ctypes
        ico = os.path.join(RES_DIR, "ui", "icon.ico")
        if not os.path.isfile(ico):
            return
        u32 = ctypes.windll.user32
        hwnd = None
        try:
            hwnd = int(window.native.Handle.ToInt64())
        except Exception:  # noqa: BLE001
            u32.FindWindowW.restype = ctypes.c_void_p
            hwnd = u32.FindWindowW(None, window.title)
        if not hwnd:
            return
        u32.LoadImageW.restype = ctypes.c_void_p
        u32.LoadImageW.argtypes = (ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint, ctypes.c_int, ctypes.c_int, ctypes.c_uint)
        u32.SendMessageW.argtypes = (ctypes.c_void_p, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p)
        for which, size in ((1, 256), (0, 32)):  # ICON_BIG, ICON_SMALL
            h = u32.LoadImageW(None, ico, 1, size, size, 0x10)  # IMAGE_ICON, LR_LOADFROMFILE
            if h:
                u32.SendMessageW(ctypes.c_void_p(hwnd), 0x0080, ctypes.c_void_p(which), ctypes.c_void_p(h))  # WM_SETICON
    except Exception:  # noqa: BLE001
        pass


def main():
    if "--selftest" in sys.argv:
        selftest()
        return
    _app_id()
    import webview
    from gigogi.api import Api

    from gigogi.core import FROZEN
    # รันจากซอร์สใช้โฟลเดอร์ WebView แยก จะได้ไม่ไปใช้แคช/โปรเซสร่วมกับโปรแกรมที่ติดตั้งไว้ซึ่งอาจเปิดอยู่
    storage = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "GiGoGi",
                           "webview" if FROZEN else "webview-dev")
    stamp = _ui_stamp()
    _clear_web_cache_on_update(storage, stamp)

    api = Api()
    # ?v=<เวอร์ชัน+เวลาไฟล์ UI> ทุกครั้งที่ไฟล์หน้าตาเปลี่ยน URL จะใหม่ WebView จึงโหลดหน้าสด ไม่ใช้แคชเก่า
    url = os.path.join(RES_DIR, "ui", "index.html") + "?v=" + stamp
    window = webview.create_window(
        "GiGoGi", url=url, js_api=api,
        width=1320, height=860, min_size=(1080, 700), background_color="#000000", text_select=True,
        minimized="--minimized" in sys.argv)  # เปิดพร้อม Windows: ย่อไว้ที่แถบงาน ให้ตั้งเวลาทำงานต่อ
    api._window = window
    window.events.loaded += api._on_loaded
    window.events.closing += api._on_closing
    window.events.shown += lambda: _set_window_icon(window)

    if "--smoke" in sys.argv:
        def smoke():
            time.sleep(8)
            try:
                res = window.evaluate_js(
                    "JSON.stringify({rail: !!document.querySelector('.rail'), inited: typeof S !== 'undefined' && S.inited,"
                    " title: document.querySelector('#page-title').textContent,"
                    " inputModes: document.querySelectorAll('#input-seg button').length,"
                    " ver: (typeof S !== 'undefined' && S.version) || '',"
                    " page: (typeof S !== 'undefined' && S.page) || '',"
                    " schedulePage: !!document.querySelector('#page-schedule'),"
                    " errors: window.__ggErrors || [], href: location.href,"
                    " font: document.fonts.check('16px \"IBM Plex Sans Thai\"')})")
                _print("smoke:", res)
                with open(os.path.join(os.environ.get("TEMP", "."), "gigogi_smoke.txt"), "w", encoding="utf-8") as f:
                    f.write(str(res))
            finally:
                window.destroy()
        threading.Thread(target=smoke, daemon=True).start()

    # ใช้พอร์ตว่างแบบสุ่มเสมอ: ค่าเริ่มต้นของ pywebview คือ 42001 ถ้าโปรแกรมอื่น (หรือ GiGoGi อีกตัว) ใช้อยู่
    # หน้าต่างนี้จะไปโหลดหน้าเว็บของโปรแกรมนั้นแทน ทำให้เห็นหน้าตาเก่าหรือผิดโปรแกรม
    webview.start(debug="--debug" in sys.argv, private_mode=False, storage_path=storage,
                  http_server=True, http_port=_free_port())


def _free_port():
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _ui_stamp():
    """เวอร์ชัน + เวลาแก้ไขล่าสุดของไฟล์หน้าตา: เปลี่ยนทุกครั้งที่อัปเดตหรือ build ใหม่ แม้เลขเวอร์ชันเดิม"""
    folder = os.path.join(RES_DIR, "ui")
    try:
        newest = max(os.path.getmtime(os.path.join(folder, f)) for f in os.listdir(folder)
                     if f.endswith((".html", ".js", ".css")))
    except (OSError, ValueError):
        newest = 0
    return f"{__version__}-{int(newest)}"


def _clear_web_cache_on_update(storage, stamp):
    """ล้างแคชหน้าเว็บของ WebView เมื่อไฟล์หน้าตาเปลี่ยน ไม่งั้นหน้าตาเก่าจะยังค้างอยู่
    ลบเฉพาะแคช (Cache / Code Cache) ไม่แตะ localStorage หรือการตั้งค่าผู้ใช้"""
    import shutil
    marker = os.path.join(os.path.dirname(storage), "ui-version.txt")
    try:
        last = open(marker, encoding="utf-8").read().strip()
    except OSError:
        last = ""
    if last == stamp:
        return
    base = os.path.join(storage, "EBWebView", "Default")
    for sub in ("Cache", "Code Cache", "GPUCache", "DawnGraphiteCache", "DawnWebGPUCache"):
        p = os.path.join(base, sub)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
    try:
        os.makedirs(os.path.dirname(marker), exist_ok=True)
        with open(marker, "w", encoding="utf-8") as f:
            f.write(stamp)
    except OSError:
        pass


if __name__ == "__main__":
    main()
