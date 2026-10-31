' Starts one round of the dubbed-row updater (grow\round.py) with its console hidden.
' Windows Task Scheduler runs this every 20 minutes (task "\StremioHebrew\DubGrow", approved by the owner 31.10.26).
CreateObject("WScript.Shell").Run """C:\Users\hod45\AppData\Local\Programs\Python\Python310\python.exe"" ""C:\Users\hod45\StremioHebrew\repo\grow\round.py""", 0, False
