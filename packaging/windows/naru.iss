; Inno Setup 6 script for the Naru Windows x64 installer.
; Built by .github/workflows/windows-release.yml:
;   ISCC /DAppVersion=1.2.3 /DSourceExe=C:\path\naru.exe /ODIR naru.iss
; Relative paths below resolve against this file's directory.

#ifndef AppVersion
  #define AppVersion "0.0.0-dev"
#endif
#ifndef SourceExe
  #define SourceExe "..\..\target\release\naru.exe"
#endif

[Setup]
AppId={{F59D8C0F-FC0F-4BD6-8BD7-7D87F39058CE}
AppName=Naru
AppVersion={#AppVersion}
AppPublisher=Simon Spoon
DefaultDirName={localappdata}\Programs\Naru
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ChangesEnvironment=yes
CloseApplications=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=naru-windows-amd64-setup
InfoAfterFile=postinstall.txt
LicenseFile=..\..\LICENSE
Compression=lzma2
SolidCompression=yes

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "naru.exe"; Flags: ignoreversion

[Registry]
Root: HKCU; Subkey: "Environment"; ValueType: expandsz; ValueName: "Path"; ValueData: "{olddata};{app}"; Check: NeedsAddPath(ExpandConstant('{app}'))

[Code]
function NeedsAddPath(Param: string): Boolean;
var
  OrigPath: string;
begin
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then
  begin
    Result := True;
    exit;
  end;
  Result := Pos(';' + Lowercase(Param) + ';', ';' + Lowercase(OrigPath) + ';') = 0;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  OrigPath, AppDir, Padded: string;
  P: Integer;
begin
  if CurUninstallStep <> usPostUninstall then exit;
  if not RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', OrigPath) then exit;
  AppDir := ExpandConstant('{app}');
  Padded := ';' + OrigPath + ';';
  P := Pos(';' + Lowercase(AppDir) + ';', Lowercase(Padded));
  if P = 0 then exit;
  Delete(Padded, P, Length(AppDir) + 1);
  { Strip the padding added above. }
  if Copy(Padded, 1, 1) = ';' then Delete(Padded, 1, 1);
  if Copy(Padded, Length(Padded), 1) = ';' then Delete(Padded, Length(Padded), 1);
  RegWriteExpandStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Padded);
end;
