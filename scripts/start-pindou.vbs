' PinDou Studio 静默启动器：隐藏控制台窗口，只弹出应用窗口
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
cmd = """" & projectDir & "\scripts\start-pindou.cmd"""

' 后台运行启动脚本（不显示黑窗口），应用窗口由 Electron 自行弹出
shell.CurrentDirectory = projectDir
shell.Run "cmd /c """ & cmd & """", 0, False
