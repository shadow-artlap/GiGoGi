<p align="center"><img src="assets/logo-1024.png" width="160" alt="GiGoGi"></p>

# GiGoGi Phone Control

โปรแกรม Windows ภาษาไทยสำหรับควบคุมมือถือ **Android** ผ่านสาย USB (หรือ Wi‑Fi)

## ดาวน์โหลด
ไปที่หน้า [Releases](https://github.com/shadow-artlap/GiGoGi/releases/latest) แล้วเลือกไฟล์ใดไฟล์หนึ่ง
- `GiGoGiPhoneControl-Setup-x.y.z.exe`: ตัวติดตั้ง (แนะนำ) มี scrcpy และ adb มาให้แล้ว
- `GiGoGiPhoneControl-x.y.z-portable.zip`: แตกไฟล์แล้วเปิด `GiGoGiPhoneControl.exe` ได้เลย

> Windows SmartScreen อาจเตือน เพราะไฟล์ยังไม่ได้เซ็นดิจิทัล ให้กด "ข้อมูลเพิ่มเติม" แล้วกด "เรียกใช้ต่อไป"

## ความสามารถ
- **หน้าหลัก**: ภาพหน้าจอมือถือ แบต พื้นที่ หน่วยความจำ และข้อมูลเครื่อง พร้อมขั้นตอนเชื่อมต่อที่บอกสถานะจริง
- **ทุกเครื่อง**: เสียบมือถือได้หลายเครื่อง เห็นหน้าจอทุกเครื่องพร้อมกัน เปิดจอสดทุกเครื่องโดยเรียงหน้าต่างให้ และสั่งปลุกจอ กลับหน้าหลัก หรือแคปจอทุกเครื่องในคลิกเดียว
- **โหมดอุปกรณ์จริง**: บางหน้า (เช่น หน้าสมัคร WhatsApp ที่ให้ใส่เบอร์และรหัส) ไม่รับการแตะแบบปกติ เปิด "โหมดอุปกรณ์จริง" ในตั้งค่า แล้วในหน้าต่างจอสดใช้เมาส์คลิกและคีย์บอร์ดพิมพ์เอง (Android 11 ขึ้นไป)
- **หน้าจอ**: จอสด (scrcpy) ที่ใช้เมาส์และคีย์บอร์ดคุมได้, ภาพหน้าจอในโปรแกรมที่แตะ ปัด และพิมพ์ได้, ปุ่มเครื่อง, แคปจอ, อัดจอ, ส่งข้อความ (รวมภาษาไทย), เปิดลิงก์
- **ไฟล์**: เรียกดู ค้นหา ลากไฟล์จากคอมมาวางเพื่ออัปโหลด ดาวน์โหลด ลบ เปลี่ยนชื่อ สร้างโฟลเดอร์
- **แอพ**: ติดตั้ง APK (ลากมาวางได้) ถอน เปิด บังคับหยุด ล้างข้อมูล ปิดหรือเปิดใช้งาน ดึง APK
- **เครื่องมือ**: เชื่อมต่อผ่าน Wi‑Fi และจับคู่ด้วยรหัส, รีสตาร์ท/Recovery/Bootloader, คำสั่ง `adb shell`, ประวัติการทำงาน
- **ตั้งค่า**: คุณภาพจอสด, เปิดจอสดอัตโนมัติเมื่อเสียบสาย, โฟลเดอร์บันทึก
- **อัปเดตในโปรแกรม**: เตือนเมื่อมีเวอร์ชันใหม่ กด "อัปเดตเลย" แล้วโปรแกรมดาวน์โหลด ติดตั้ง และเปิดใหม่ให้เอง (เฉพาะแบบติดตั้ง ส่วนแบบ portable จะพาไปหน้าดาวน์โหลด)

ไฟล์ที่บันทึกจะอยู่ใน `เอกสาร\GiGoGi` (เปลี่ยนได้ในหน้าตั้งค่า) แยกเป็น Screenshots, Recordings, Downloads และ APK

คีย์ลัด: `Ctrl+1` ถึง `Ctrl+7` สลับหน้า, ในหน้าไฟล์ `Delete` ลบ `F2` เปลี่ยนชื่อ `Backspace` ย้อนกลับขึ้นโฟลเดอร์

## เตรียมมือถือ
1. ตั้งค่า > เกี่ยวกับโทรศัพท์ > แตะ "หมายเลขบิลด์" 7 ครั้ง
2. ตัวเลือกสำหรับนักพัฒนา > เปิด **USB debugging**
   (Xiaomi/POCO: เปิด **USB debugging (Security settings)** ด้วย)
3. เสียบสาย แล้วกด **อนุญาต** บนมือถือ

---

## สำหรับนักพัฒนา

### รันจากซอร์ส
```powershell
pip install -r requirements.txt
python phone_control.py              # เปิดโปรแกรม
python phone_control.py --debug      # เปิดพร้อม DevTools (คลิกขวา > Inspect)
python phone_control.py --selftest   # ทดสอบตัวแยกข้อมูล + หาเครื่องมือ
python phone_control.py --smoke      # เปิดหน้าต่าง ตรวจว่า UI โหลดได้ แล้วปิดเอง
```
ต้องมี Python 3.10 ขึ้นไป, WebView2 (มีใน Windows 10/11) และ adb/scrcpy (`winget install Google.PlatformTools Genymobile.scrcpy`)

**แก้หน้าตาโดยไม่ต้องมีมือถือ:** `python -m http.server 8765 --directory ui` แล้วเปิด `http://localhost:8765/index.html?demo`
(หรือ `?demo=none`, `?demo=unauthorized`, `?demo=multi`) ระบบจะใช้ข้อมูลจำลองจาก `ui/demo.js`

### โครงสร้าง
| ไฟล์ | หน้าที่ |
|---|---|
| `phone_control.py` | จุดเริ่มโปรแกรม เปิดหน้าต่าง pywebview |
| `gigogi/core.py` | หาเครื่องมือ เรียก adb และแยกข้อมูลผลลัพธ์ |
| `gigogi/api.py` | ฟังก์ชันทั้งหมดที่หน้า UI เรียกใช้ |
| `ui/` | หน้าตาโปรแกรม (HTML/CSS/JS, ฟอนต์, โลโก้) |
| `assets/` | ไอคอนและโลโก้ต้นฉบับ |
| `version.py` | เลขเวอร์ชัน (แก้ที่เดียว) |
| `installer/GiGoGi.iss` | สคริปต์ตัวติดตั้ง Inno Setup |
| `scripts/build.ps1` | สร้าง .exe, ใส่ scrcpy, สร้าง Setup.exe และ .zip |
| `scripts/release.ps1` | ออกเวอร์ชันใหม่ (แก้เวอร์ชัน, tag, push) |
| `.github/workflows/build.yml` | GitHub Actions build ทุก push และสร้าง Release เมื่อ push tag |
| `PLAN.md` | การวิเคราะห์ความต้องการ ปัญหา และวิธีแก้ |

### สร้างตัวติดตั้งในเครื่อง
```powershell
winget install JRSoftware.InnoSetup
powershell -ExecutionPolicy Bypass -File scripts\build.ps1
```
ผลลัพธ์จะอยู่ในโฟลเดอร์ `dist\`

### ออกเวอร์ชันใหม่
1. แก้โค้ด แล้ว commit
2. รัน `scripts\release.ps1 1.1.0` ครั้งแรก สคริปต์จะเพิ่มหัวข้อใน `CHANGELOG.md` ให้ จากนั้นเขียนรายละเอียดลงไป
3. รัน `scripts\release.ps1 1.1.0` อีกครั้ง สคริปต์จะ commit, tag `v1.1.0` และ push
4. GitHub Actions จะ build แล้วสร้าง Release พร้อมไฟล์ติดตั้งให้เอง โปรแกรมที่ผู้ใช้ติดตั้งไว้ (ตั้งแต่ 2.1.0) จะขึ้นหน้าต่างอัปเดตพร้อมรายการจาก `CHANGELOG.md` และติดตั้งให้ในคลิกเดียว

ทดสอบระบบอัปเดตโดยไม่ติดตั้งจริง: ตั้ง `GIGOGI_FAKE_VERSION=1.0.0` และ `GIGOGI_UPDATE_DRYRUN=1` ก่อนรัน `python phone_control.py`
ดูหน้าต่างอัปเดตแบบจำลอง: `http://localhost:8765/index.html?demo&update`

ตัวติดตั้งใช้ `AppId` เดิมตลอด การลงเวอร์ชันใหม่จึงทับของเก่าได้เลย ไม่ต้องถอนก่อน

## ไลเซนส์ของส่วนประกอบ
ดูได้ที่ [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) (scrcpy และ adb ใช้ Apache 2.0)
