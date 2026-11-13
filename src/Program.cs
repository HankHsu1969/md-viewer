using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: AssemblyTitle("MD 閱讀器")]
[assembly: AssemblyProduct("MD 閱讀器")]
[assembly: AssemblyDescription("Markdown 檔案閱讀器")]
[assembly: AssemblyCopyright("Hank Hsu")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace MDViewer
{
    static class Program
    {
        static readonly Dictionary<string, Assembly> loaded = new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);

        [STAThread]
        static void Main(string[] args)
        {
            // WebView2 的 DLL 都包在 EXE 裡面，需要時才從資源載入
            AppDomain.CurrentDomain.AssemblyResolve += ResolveEmbedded;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
            Application.ThreadException += (s, e) => ShowError(e.Exception);
            AppDomain.CurrentDomain.UnhandledException += (s, e) => ShowError(e.ExceptionObject as Exception);

            string path = null;
            foreach (string a in args)
            {
                if (!string.IsNullOrWhiteSpace(a) && !a.StartsWith("--")) { path = a; break; }
            }
            // 先把檔案路徑轉成完整路徑，再把「目前資料夾」換到系統資料夾。
            // 雙擊 .md 時，Windows 會把目前資料夾設成那個 .md 所在的資料夾；
            // 若裡面藏了同名的假程式或假 DLL，就可能被誤載入，所以要先離開。
            if (path != null)
            {
                try { path = Path.GetFullPath(path.Trim('"')); } catch { }
            }
            try
            {
                SetDllDirectory("");
                Environment.CurrentDirectory = Environment.SystemDirectory;
            }
            catch { }
            Run(path);
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        static extern bool SetDllDirectory(string path);

        [MethodImpl(MethodImplOptions.NoInlining)]
        static void Run(string path)
        {
            Application.Run(new MainForm(path));
        }

        static Assembly ResolveEmbedded(object sender, ResolveEventArgs e)
        {
            string name = new AssemblyName(e.Name).Name;
            lock (loaded)
            {
                Assembly asm;
                if (loaded.TryGetValue(name, out asm)) return asm;
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("deps." + name + ".dll"))
                {
                    if (s == null) return null;
                    byte[] buf = new byte[s.Length];
                    int off = 0;
                    while (off < buf.Length)
                    {
                        int n = s.Read(buf, off, buf.Length - off);
                        if (n <= 0) break;
                        off += n;
                    }
                    asm = Assembly.Load(buf);
                    loaded[name] = asm;
                    return asm;
                }
            }
        }

        internal static void ShowError(Exception ex)
        {
            if (ex == null) return;
            try
            {
                MessageBox.Show("發生錯誤：\n\n" + ex.Message, "MD 閱讀器", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            catch { }
        }
    }
}
