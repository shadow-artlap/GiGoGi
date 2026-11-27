# -*- coding: utf-8 -*-
"""
จอสัมผัสเสมือนแบบ HID ผ่าน scrcpy-server (ฟังก์ชัน UHID ของ scrcpy)

ทำไมต้องมี: บางหน้า (เช่น หน้าลงทะเบียน WhatsApp) ทิ้งการแตะที่สร้างด้วย `adb shell input`
เพราะไม่ได้มาจากอุปกรณ์จริง โมดูลนี้สร้าง "จอสัมผัส" ในเคอร์เนลผ่าน /dev/uhid การแตะจึงมาจาก
อุปกรณ์จริงในสายตาของ Android และระบุตำแหน่งแบบสัมบูรณ์ (absolute) จึงใช้ผ่านโปรแกรมรีโมตได้
(ต่างจากเมาส์ HID ที่ต้องจับเมาส์และอ่านการขยับแบบ relative)

โครง HID เป็นจอสัมผัสนิ้วเดียวตามสเปก Windows Precision Touch (มี Contact ID + Contact Count)
เพื่อให้ไดรเวอร์ hid-multitouch ของ Linux/Android จัดเป็น "จอสัมผัสตรง" (ABS_MT) ไม่ใช่เมาส์

โปรโตคอล control ของ scrcpy v5 (ทุกค่าเป็น big-endian):
  UHID_CREATE (12): u8 type | u16 id | u16 vendor | u16 product | u8 nameLen+name | u16 rdLen+rd
  UHID_INPUT  (13): u8 type | u16 id | u16 len+data
  UHID_DESTROY(14): u8 type | u16 id
"""

import os
import random
import re
import socket
import struct
import subprocess
import threading
import time

from .core import NO_WINDOW, AdbError

REMOTE_JAR = "/data/local/tmp/gigogi-hid.jar"
HID_ID = 0x61
MAX = 32767

# จอสัมผัสนิ้วเดียว (Windows Precision Touchscreen): Tip Switch + Contact ID + X + Y + Contact Count
REPORT_DESC = bytes([
    0x05, 0x0D,        # Usage Page (Digitizer)
    0x09, 0x04,        # Usage (Touch Screen)
    0xA1, 0x01,        # Collection (Application)
    0x09, 0x22,        #   Usage (Finger)
    0xA1, 0x02,        #   Collection (Logical)
    0x09, 0x42,        #     Usage (Tip Switch)
    0x15, 0x00,        #     Logical Minimum (0)
    0x25, 0x01,        #     Logical Maximum (1)
    0x75, 0x01,        #     Report Size (1)
    0x95, 0x01,        #     Report Count (1)
    0x81, 0x02,        #     Input (Data,Var,Abs)
    0x75, 0x07,        #     Report Size (7)
    0x95, 0x01,        #     Report Count (1)
    0x81, 0x03,        #     Input (Const)  padding
    0x09, 0x51,        #     Usage (Contact Identifier)
    0x25, 0x7F,        #     Logical Maximum (127)
    0x75, 0x08,        #     Report Size (8)
    0x95, 0x01,        #     Report Count (1)
    0x81, 0x02,        #     Input (Data,Var,Abs)
    0x05, 0x01,        #     Usage Page (Generic Desktop)
    0x26, 0xFF, 0x7F,  #     Logical Maximum (32767)
    0x75, 0x10,        #     Report Size (16)
    0x95, 0x01,        #     Report Count (1)
    0x09, 0x30,        #     Usage (X)
    0x81, 0x02,        #     Input (Data,Var,Abs)
    0x09, 0x31,        #     Usage (Y)
    0x81, 0x02,        #     Input (Data,Var,Abs)
    0xC0,              #   End Collection
    0x05, 0x0D,        #   Usage Page (Digitizer)
    0x09, 0x54,        #   Usage (Contact Count)
    0x25, 0x7F,        #   Logical Maximum (127)
    0x75, 0x08,        #   Report Size (8)
    0x95, 0x01,        #   Report Count (1)
    0x81, 0x02,        #   Input (Data,Var,Abs)
    0xC0,              # End Collection
])


def scrcpy_version(scrcpy_path):
    """เวอร์ชันของ scrcpy ที่ server ต้องตรงกันเป๊ะ"""
    try:
        r = subprocess.run([scrcpy_path, "--version"], capture_output=True, timeout=15, creationflags=NO_WINDOW)
        m = re.search(r"scrcpy\s+v?(\d+\.\d+(?:\.\d+)?)", r.stdout.decode("utf-8", "replace"))
        if m:
            return m.group(1)
    except (OSError, subprocess.TimeoutExpired):
        pass
    m = re.search(r"v(\d+\.\d+(?:\.\d+)?)", os.path.dirname(scrcpy_path))
    return m.group(1) if m else None


def _report(tip, x, y):
    # byte0 tip (bit0) | byte1 contact id | X u16 LE | Y u16 LE | byte6 contact count
    return struct.pack("<BBHHB", 1 if tip else 0, 0, x, y, 1 if tip else 0)


class HidTouch:
    """จอสัมผัสเสมือนของมือถือหนึ่งเครื่อง (ต่อหนึ่ง serial)"""

    def __init__(self, adb_path, scrcpy_path, serial):
        self.adb_path, self.scrcpy_path, self.serial = adb_path, scrcpy_path, serial
        self.proc = None
        self.sock = None
        self.port = None
        self.lock = threading.Lock()
        self.size = (1080, 2340)   # ขนาดจอจริง อัปเดตจากผู้เรียก

    def _adb(self, *args, timeout=30):
        r = subprocess.run([self.adb_path, "-s", self.serial, *args], capture_output=True,
                           timeout=timeout, creationflags=NO_WINDOW, stdin=subprocess.DEVNULL)
        return r.returncode, r.stdout.decode("utf-8", "replace") + r.stderr.decode("utf-8", "replace")

    def alive(self):
        return self.sock is not None and self.proc is not None and self.proc.poll() is None

    def start(self):
        if self.alive():
            return
        self.close()
        version = scrcpy_version(self.scrcpy_path)
        server = os.path.join(os.path.dirname(self.scrcpy_path), "scrcpy-server")
        if not version or not os.path.isfile(server):
            raise AdbError("ไม่พบ scrcpy-server สำหรับการแตะแบบสัมผัสจริง")
        _, out = self._adb("shell", f"stat -c %s {REMOTE_JAR} 2>/dev/null")
        if out.strip() != str(os.path.getsize(server)):
            code, out = self._adb("push", server, REMOTE_JAR, timeout=60)
            if code != 0:
                raise AdbError(f"ส่งไฟล์ไปมือถือไม่ได้: {out.strip()[-160:]}")
        scid = random.randint(0x1000, 0x7FFFFFFF)
        name = f"scrcpy_{scid:08x}"
        cmd = (f"CLASSPATH={REMOTE_JAR} app_process / com.genymobile.scrcpy.Server {version} "
               f"scid={scid:08x} log_level=warn video=false audio=false control=true tunnel_forward=true "
               f"send_device_meta=false cleanup=false power_on=false clipboard_autosync=false")
        self.proc = subprocess.Popen([self.adb_path, "-s", self.serial, "shell", cmd],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                     stdin=subprocess.DEVNULL, creationflags=NO_WINDOW)
        code, out = self._adb("forward", "tcp:0", f"localabstract:{name}")
        if code != 0 or not out.strip().isdigit():
            self.close()
            raise AdbError("เปิดช่องสื่อสารกับมือถือไม่ได้ (ลองใหม่อีกครั้ง)")
        self.port = int(out.strip())
        deadline = time.time() + 10
        while time.time() < deadline:
            if self.proc.poll() is not None:
                err = self.proc.stderr.read().decode("utf-8", "replace") if self.proc.stderr else ""
                self.close()
                hint = "มือถือรุ่นนี้อาจไม่รองรับ (ต้อง Android 11 ขึ้นไป)"
                raise AdbError("เริ่มการแตะแบบสัมผัสจริงไม่ได้: " + ((err.strip().splitlines() or [hint])[-1]))
            try:
                s = socket.create_connection(("127.0.0.1", self.port), timeout=2)
                s.settimeout(3)
                if s.recv(1) == b"\x00":  # dummy byte = server พร้อม
                    s.settimeout(None)
                    self.sock = s
                    break
                s.close()
            except OSError:
                pass
            time.sleep(0.15)
        if not self.sock:
            self.close()
            raise AdbError("มือถือไม่ตอบสนองการแตะแบบสัมผัสจริง")
        dev_name = b"GiGoGi Touch"
        msg = struct.pack(">BHHHB", 12, HID_ID, 0x18D1, 0x4EE7, len(dev_name)) + dev_name \
            + struct.pack(">H", len(REPORT_DESC)) + REPORT_DESC
        self.sock.sendall(msg)
        time.sleep(0.5)  # ให้ Android ลงทะเบียนจอสัมผัสใหม่

    def close(self):
        if self.sock:
            try:
                self.sock.sendall(struct.pack(">BH", 14, HID_ID))
            except OSError:
                pass
            try:
                self.sock.close()
            except OSError:
                pass
        self.sock = None
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
        self.proc = None
        if self.port:
            self._adb("forward", "--remove", f"tcp:{self.port}")
            self.port = None

    def _send(self, tip, x, y):
        w, h = self.size
        lx = max(0, min(MAX, round(x * MAX / max(1, w - 1))))
        ly = max(0, min(MAX, round(y * MAX / max(1, h - 1))))
        data = _report(tip, lx, ly)
        self.sock.sendall(struct.pack(">BHH", 13, HID_ID, len(data)) + data)

    def _run(self, points, hold_ms=0, size=None):
        with self.lock:
            if size:
                self.size = size
            self.start()
            try:
                x, y = points[0]
                self._send(True, x, y)
                time.sleep(max(0.03, hold_ms / 1000))
                for x, y in points[1:]:
                    self._send(True, x, y)
                    time.sleep(0.012)
                self._send(False, x, y)
            except OSError:
                self.close()
                raise AdbError("การแตะแบบสัมผัสจริงหลุด ลองอีกครั้ง")

    def tap(self, x, y, size=None):
        self._run([(x, y)], hold_ms=60, size=size)

    def long_press(self, x, y, size=None):
        self._run([(x, y)], hold_ms=650, size=size)

    def swipe(self, x1, y1, x2, y2, ms, size=None):
        steps = max(4, int(ms / 12))
        pts = [(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps) for i in range(steps + 1)]
        self._run(pts, hold_ms=25, size=size)
