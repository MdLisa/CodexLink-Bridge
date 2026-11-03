using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using System.Management.Automation;
using System.Management.Automation.Runspaces;
using System.Threading;

// Small Windows launcher: no console, no third-party runtime beyond the existing Node.js.
internal static class CodexLinkLauncher {
    [STAThread]
    private static void Main(string[] args) {
        try {
            string folder = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
#if PREVIEW
            folder = Directory.GetParent(folder).FullName;
#endif
            if (args.Length == 1 && args[0] == "--window") {
                using (Runspace runspace = RunspaceFactory.CreateRunspace()) {
                    runspace.ApartmentState = ApartmentState.STA;
                    runspace.ThreadOptions = PSThreadOptions.UseCurrentThread;
                    runspace.Open();
                    using (PowerShell script = PowerShell.Create()) {
                        script.Runspace = runspace;
                        script.AddScript(File.ReadAllText(Path.Combine(folder, @"scripts\gui.ps1")));
                        script.Invoke();
                        if (script.HadErrors) throw new Exception(script.Streams.Error[0].ToString());
                    }
                }
                return;
            }
            string node = null;
            foreach (string item in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';')) {
                if (String.IsNullOrWhiteSpace(item)) continue;
                string candidate;
                try { candidate = Path.Combine(item.Trim('"'), "node.exe"); } catch { continue; }
                if (File.Exists(candidate)) { node = candidate; break; }
            }
            if (node == null) node = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), @".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe");
            if (!File.Exists(node)) throw new Exception("需要 Node.js 24 或更新版本。请先打开一次 Codex，或安装 Node.js。");
            string entry = Path.Combine(folder, @"scripts\gui.mjs");
            if (!File.Exists(entry)) throw new Exception("没有找到 scripts\\gui.mjs，请将启动器放在 CodexLink 程序目录中。");
            var start = new ProcessStartInfo(node, "\"" + entry + "\"");
            start.WorkingDirectory = folder;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.EnvironmentVariables["CODEXLINK_WINDOW_HOST"] = Assembly.GetExecutingAssembly().Location;
#if PREVIEW
            start.EnvironmentVariables["BRIDGE_DATA_DIR"] = Path.Combine(folder, @".gui-test\data");
#endif
            Process.Start(start);
        } catch (Exception error) {
            MessageBox.Show(error.Message, "CodexLink", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
