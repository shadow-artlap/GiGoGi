; Inno Setup script for GiGoGi Phone Control
; Built by scripts\build.ps1:  ISCC /DAppVersion=x.y.z /DBuildDir=<path> GiGoGi.iss

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef BuildDir
  #define BuildDir "..\build\dist\GiGoGiPhoneControl"
#endif
#define AppName "GiGoGi Phone Control"
#define AppExe "GiGoGiPhoneControl.exe"
#define AppUrl "https://github.com/shadow-artlap/GiGoGi"

[Setup]
; AppId must never change: it lets new versions upgrade the old install in place
AppId={{386F255B-F449-45DD-9399-68FAFCA18516}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
AppPublisher=shadow-artlap
AppPublisherURL={#AppUrl}
AppSupportURL={#AppUrl}/issues
AppUpdatesURL={#AppUrl}/releases
DefaultDirName={autopf}\{#AppName}
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
; per-user install by default, no admin needed (user can choose all-users)
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=GiGoGiPhoneControl-Setup-{#AppVersion}
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\{#AppExe}
SetupIconFile=..\assets\icon.ico
UninstallDisplayName={#AppName}
CloseApplications=yes
VersionInfoVersion={#AppVersion}
LicenseFile=..\THIRD_PARTY_NOTICES.txt

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[InstallDelete]
; remove files from the previous version so old libraries never mix with new ones
Type: filesandordirs; Name: "{app}\_internal"
Type: filesandordirs; Name: "{app}\tools"

[Files]
Source: "{#BuildDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{group}\{cm:UninstallProgram,{#AppName}}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
; อัปเดตจากในโปรแกรม (ติดตั้งแบบเงียบด้วย /RELAUNCH): เปิดโปรแกรมกลับมาให้เอง
Filename: "{app}\{#AppExe}"; Flags: nowait runasoriginaluser; Check: IsRelaunch

[Registry]
; ตัวเลือก "เปิด GiGoGi พร้อม Windows" เขียนค่านี้ตอนใช้งาน ลบออกเมื่อถอนการติดตั้ง
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "GiGoGi"; Flags: uninsdeletevalue dontcreatekey

[UninstallRun]
Filename: "{app}\tools\scrcpy\adb.exe"; Parameters: "kill-server"; Flags: runhidden skipifdoesntexist; RunOnceId: "KillAdb"

[Code]
function IsRelaunch: Boolean;
var
  I: Integer;
begin
  Result := False;
  for I := 1 to ParamCount do
    if CompareText(ParamStr(I), '/RELAUNCH') = 0 then
      Result := True;
end;

// A running adb server from the bundled tools locks adb.exe; stop it before upgrading.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  Adb: String;
begin
  Adb := ExpandConstant('{app}\tools\scrcpy\adb.exe');
  if FileExists(Adb) then
    Exec(Adb, 'kill-server', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Result := '';
end;
