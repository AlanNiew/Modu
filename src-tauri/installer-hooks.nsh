; 墨读安装器钩子（Tauri NSIS `installerHooks`）
;
; 用途：卸载时清理「开机自动启动」注册项。
;
; 背景：tauri-plugin-autostart 在 Windows 上把自启项写在
;   HKCU\Software\Microsoft\Windows\CurrentVersion\Run\<应用包名>
; 其中「应用包名」= 主二进制名 modu（不是显示用的产品名「墨读」）。
; NSIS 默认模板只删产品名那一条，会把 modu 这条留在注册表里，
; 造成「卸载后开机仍拉起一个不存在的程序」。这里两条都删。
;
; 只在「非更新卸载」时执行：升级安装（/UPDATE）不能动自启项，
; 否则用户勾选的开机自启会在每次更新后丢失。
!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${MAINBINARYNAME}"
  ${EndIf}
!macroend
