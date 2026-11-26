# GiGoGi Phone Control

โปรแกรม Windows ภาษาไทยสำหรับควบคุมมือถือ **Android** ผ่านสาย USB (หรือ Wi‑Fi)

## ดาวน์โหลด
ไปที่หน้า [Releases](https://github.com/shadow-artlap/GiGoGi/releases/latest) แล้วเลือกไฟล์ใดไฟล์หนึ่ง
- `GiGoGiPhoneControl-Setup-x.y.z.exe`: ตัวติดตั้ง (แนะนำ) มี scrcpy และ adb มาให้แล้ว
- `GiGoGiPhoneControl-x.y.z-portable.zip`: แตกไฟล์แล้วเปิด `GiGoGiPhoneControl.exe` ได้เลย

> Windows SmartScreen อาจเตือน เพราะไฟล์ยังไม่ได้เซ็นดิจิทัล ให้กด "ข้อมูลเพิ่มเติม" แล้วกด "เรียกใช้ต่อไป"

## ความสามารถ
- **ภาพรวม**: ยี่ห้อ รุ่น Android แบต อุณหภูมิ พื้นที่ จอ IP
- **หน้าจอ & ควบคุม**: จอสด (scrcpy) ที่ใช้เมาส์/คีย์บอร์ดคุมได้, พรีวิวที่คลิกแตะ/ลากปัดได้, แคปจอ, อัดจอ, ปุ่ม Home/Back/Power/เสียง, ส่งข้อความ, เปิดลิงก์
- **ไฟล์**: เรียกดู อัปโหลด ดาวน์โหลด ลบ เปลี่ยนชื่อ สร้างโฟลเดอร์
- **แอพ**: ติดตั้ง APK ถอน เปิด บังคับหยุด ล้างข้อมูล ดึง APK
- **เทอร์มินัล**: รันคำสั่ง `adb shell`
- เปิดจอสดอัตโนมัติเมื่อเสียบสาย, ใช้ผ่าน Wi‑Fi, รีบูต, แจ้งเตือนเมื่อมีเวอร์ชันใหม่

## เตรียมมือถือ
1. ตั้งค่า > เกี่ยวกับโทรศัพท์ > แตะ "หมายเลขบิลด์" 7 ครั้ง
2. ตัวเลือกสำหรับนักพัฒนา > เปิด **USB debugging**
   (Xiaomi/POCO: เปิด **USB debugging (Security settings)** ด้วย)
3. เสียบสาย แล้วกด **อนุญาต** บนมือถือ

---

## สำหรับนักพัฒนา

### รันจากซอร์ส
```powershell
python phone_control.py              # เปิดโปรแกรม
python phone_control.py --selftest   # ทดสอบตัวแยกข้อมูล + หาเครื่องมือ
python phone_control.py --smoke      # เปิดหน้าต่าง 3 วิแล้วปิด
```
ต้องมี Python 3.10 ขึ้นไป (มี Tkinter) และ adb/scrcpy (`winget install Google.PlatformTools Genymobile.scrcpy`)

### โครงสร้าง
| ไฟล์ | หน้าที่ |
|---|---|
| `phone_control.py` | ตัวโปรแกรมทั้งหมด (Tkinter + adb/scrcpy) |
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
4. GitHub Actions จะ build แล้วสร้าง Release พร้อมไฟล์ติดตั้งให้เอง โปรแกรมที่ผู้ใช้ติดตั้งไว้จะเตือนว่ามีเวอร์ชันใหม่

ตัวติดตั้งใช้ `AppId` เดิมตลอด การลงเวอร์ชันใหม่จึงทับของเก่าได้เลย ไม่ต้องถอนก่อน

## ไลเซนส์ของส่วนประกอบ
ดูได้ที่ [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt) (scrcpy และ adb ใช้ Apache 2.0)
