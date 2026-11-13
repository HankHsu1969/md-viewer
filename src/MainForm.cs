using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace MDViewer
{
    public class MainForm : Form
    {
        const string AppTitle = "MD 閱讀器";
        const string AppHost = "mdviewer.example";
        const string DriveHostSuffix = ".mddrive.example";
        const long MaxFileBytes = 64L * 1024 * 1024;
        static readonly string DataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "MDViewer");
        static readonly double[] ZoomSteps = { 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0 };
        static readonly string[] MarkdownExts = { ".md", ".markdown", ".mdown", ".mkd", ".mkdn", ".mdwn", ".mdtxt", ".mdtext", ".txt" };

        static readonly string ExplorerExe = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "explorer.exe");
        const string ContentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' https: data: blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

        readonly WebView2 web;
        CoreWebView2 core;
        CoreWebView2Environment coreEnv;
        readonly Dictionary<string, string> webResources = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string pendingPath;
        string currentPath;
        string lastText;
        bool pageReady;
        bool darkTheme;
        // 網路圖片：預設不自動載入（避免寄檔案的人知道你何時開啟）
        bool remoteAlways;
        bool remoteAllowedForDoc;
        int remoteBlocked;
        bool remoteNoticeQueued;
        // 顯示元件當掉時只自動重開一次，避免同一個檔案一直當掉、一直重開
        string crashedPath;
        bool crashNotice;
        FileSystemWatcher watcher;
        readonly System.Windows.Forms.Timer reloadTimer;
        readonly Dictionary<string, string> hostRoots = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        readonly Dictionary<string, string> uncHosts = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        readonly JavaScriptSerializer json = new JavaScriptSerializer();

        public MainForm(string path)
        {
            pendingPath = path;
            json.MaxJsonLength = int.MaxValue;
            Text = AppTitle;
            try
            {
                using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("app.ico"))
                {
                    if (s != null) Icon = new Icon(s);
                }
            }
            catch { }

            AllowDrop = false;
            KeyPreview = false;
            StartPosition = FormStartPosition.Manual;
            LoadWindowBounds();
            ApplyBackground();

            web = new WebView2();
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = BackColor;
            Controls.Add(web);

            reloadTimer = new System.Windows.Forms.Timer();
            reloadTimer.Interval = 250;
            reloadTimer.Tick += (s, e) =>
            {
                reloadTimer.Stop();
                if (currentPath != null) LoadFile(currentPath, true, null);
            };

            Load += OnFormLoad;
            FormClosing += (s, e) => { SaveWindowBounds(); StopWatching(); };
            HandleCreated += (s, e) => ApplyTitleBar();
        }

        /* ================= 啟動 WebView2 ================= */

        async void OnFormLoad(object sender, EventArgs e)
        {
            try
            {
                Directory.CreateDirectory(DataDir);
                string loaderDir;
                using (Mutex mtx = new Mutex(false, "MDViewer-Extract"))
                {
                    try { mtx.WaitOne(10000); } catch (AbandonedMutexException) { }
                    try { loaderDir = ExtractLoader(); }
                    finally
                    {
                        try { mtx.ReleaseMutex(); } catch { }
                    }
                }
                // 舊版會把網頁檔解壓到這裡，新版直接從 EXE 內讀取，順手清掉
                try { Directory.Delete(Path.Combine(DataDir, "web"), true); } catch { }
                foreach (string name in Assembly.GetExecutingAssembly().GetManifestResourceNames())
                    if (name.StartsWith("web/")) webResources[name.Substring(4)] = name;

                CoreWebView2Environment.SetLoaderDllFolderPath(loaderDir);
                coreEnv = await CoreWebView2Environment.CreateAsync(null, Path.Combine(DataDir, "WebView2"), new CoreWebView2EnvironmentOptions());
                await web.EnsureCoreWebView2Async(coreEnv);
                core = web.CoreWebView2;

                bool dev = Environment.GetEnvironmentVariable("MDVIEWER_DEVTOOLS") == "1";
                CoreWebView2Settings st = core.Settings;
                st.AreDevToolsEnabled = dev;
                st.AreBrowserAcceleratorKeysEnabled = dev;
                st.IsStatusBarEnabled = false;
                st.IsZoomControlEnabled = true;
                st.AreHostObjectsAllowed = false;
                st.IsGeneralAutofillEnabled = false;
                st.IsPasswordAutosaveEnabled = false;
                st.IsWebMessageEnabled = true;

                // 所有網路請求都先經過 OnWebResourceRequested：
                // 程式自己的網頁直接從 EXE 內提供；網路圖片依設定決定要不要擋
                core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += OnWebResourceRequested;

                core.WebMessageReceived += OnWebMessage;
                core.NavigationStarting += OnNavigationStarting;
                core.NewWindowRequested += (s, a) => { a.Handled = true; OpenExternal(a.Uri); };
                // 閱讀器用不到相機、麥克風、定位、下載等功能，一律拒絕
                core.PermissionRequested += (s, a) => { a.State = CoreWebView2PermissionState.Deny; };
                core.DownloadStarting += (s, a) => { a.Cancel = true; };
                core.ProcessFailed += (s, a) =>
                {
                    if (a.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessExited ||
                        a.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
                    {
                        if (currentPath != null && string.Equals(crashedPath, currentPath, StringComparison.OrdinalIgnoreCase))
                        {
                            // 同一個檔案第二次當掉：不再自動開它，回首頁並說明
                            crashNotice = true;
                            pendingPath = null;
                            currentPath = null;
                            lastText = null;
                            StopWatching();
                            Text = AppTitle;
                        }
                        else
                        {
                            crashedPath = currentPath;
                            if (currentPath != null) pendingPath = currentPath;
                        }
                        try { core.Reload(); } catch { }
                    }
                };

                core.Navigate("https://" + AppHost + "/index.html");
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this,
                    "這台電腦缺少「Microsoft Edge WebView2 Runtime」。\n\n" +
                    "Windows 11 通常內建，若沒有，請到微軟官網搜尋「WebView2 Runtime」下載安裝（Evergreen 版本），裝好後再開啟本程式。",
                    AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Warning);
                Close();
            }
            catch (Exception ex)
            {
                Program.ShowError(ex);
                Close();
            }
        }

        static string ExeStamp()
        {
            FileInfo fi = new FileInfo(Assembly.GetExecutingAssembly().Location);
            return fi.Length.ToString("x") + "-" + fi.LastWriteTimeUtc.Ticks.ToString("x");
        }

        static string ExtractLoader()
        {
            string root = Path.Combine(DataDir, "bin");
            string dir = Path.Combine(root, ExeStamp());
            string dll = Path.Combine(dir, "WebView2Loader.dll");
            byte[] want;
            using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("deps.WebView2Loader.dll"))
            using (MemoryStream ms = new MemoryStream())
            {
                s.CopyTo(ms);
                want = ms.ToArray();
            }
            // 每次啟動都比對內容，避免載入被別人換掉的 DLL
            if (!File.Exists(dll) || !SameBytes(File.ReadAllBytes(dll), want))
            {
                Directory.CreateDirectory(dir);
                string tmp = dll + "." + Guid.NewGuid().ToString("N") + ".tmp";
                File.WriteAllBytes(tmp, want);
                if (File.Exists(dll)) File.Delete(dll);
                File.Move(tmp, dll);
                CleanOld(root, dir);
            }
            LoadLibrary(dll);
            return dir;
        }

        static bool SameBytes(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
            return true;
        }

        static void CleanOld(string root, string keep)
        {
            try
            {
                foreach (string d in Directory.GetDirectories(root))
                {
                    if (string.Equals(d, keep, StringComparison.OrdinalIgnoreCase)) continue;
                    try { Directory.Delete(d, true); } catch { }
                }
            }
            catch { }
        }

        /* ================= 網路請求：程式網頁、網路圖片 ================= */

        void OnWebResourceRequested(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            Uri u;
            if (!Uri.TryCreate(e.Request.Uri, UriKind.Absolute, out u)) return;
            if (u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeHttp) return;

            if (string.Equals(u.Host, AppHost, StringComparison.OrdinalIgnoreCase))
            {
                ServeAppResource(e, u);
                return;
            }
            if (u.Host.EndsWith(DriveHostSuffix, StringComparison.OrdinalIgnoreCase))
            {
                ServeLocalMedia(e, u); // 文件旁邊的本機圖片
                return;
            }

            // 其他都是網路上的資源（例如文件裡的網路圖片）
            if (remoteAlways || remoteAllowedForDoc) return;
            e.Response = coreEnv.CreateWebResourceResponse(null, 403, "Blocked", "Cache-Control: no-store");
            remoteBlocked++;
            if (!remoteNoticeQueued)
            {
                remoteNoticeQueued = true;
                BeginInvoke((Action)(() =>
                {
                    remoteNoticeQueued = false;
                    Send("{\"type\":\"remoteBlocked\",\"count\":" + remoteBlocked + "}");
                }));
            }
        }

        void ServeAppResource(CoreWebView2WebResourceRequestedEventArgs e, Uri u)
        {
            string path = Uri.UnescapeDataString(u.AbsolutePath).TrimStart('/');
            if (path.Length == 0) path = "index.html";
            string name;
            if (!webResources.TryGetValue(path, out name))
            {
                e.Response = coreEnv.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            string ext = (Path.GetExtension(path) ?? "").ToLowerInvariant();
            string type;
            switch (ext)
            {
                case ".html": type = "text/html; charset=utf-8"; break;
                case ".js": type = "text/javascript; charset=utf-8"; break;
                case ".css": type = "text/css; charset=utf-8"; break;
                case ".woff2": type = "font/woff2"; break;
                case ".txt": type = "text/plain; charset=utf-8"; break;
                case ".png": type = "image/png"; break;
                case ".svg": type = "image/svg+xml"; break;
                default: type = "application/octet-stream"; break;
            }
            string headers = "Content-Type: " + type + "\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-cache";
            if (ext == ".html") headers += "\r\nContent-Security-Policy: " + ContentSecurityPolicy;
            Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream(name);
            e.Response = coreEnv.CreateWebResourceResponse(s, 200, "OK", headers);
        }

        /* ================= 本機圖片（讓文件裡的相對路徑圖片能顯示） ================= */

        // 只提供圖片、影音檔；其他類型的檔案（文字、程式、文件…）一律不給網頁讀取
        static readonly Dictionary<string, string> MediaTypes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            { ".png", "image/png" }, { ".jpg", "image/jpeg" }, { ".jpeg", "image/jpeg" }, { ".gif", "image/gif" },
            { ".webp", "image/webp" }, { ".bmp", "image/bmp" }, { ".ico", "image/x-icon" }, { ".avif", "image/avif" },
            { ".svg", "image/svg+xml" }, { ".mp4", "video/mp4" }, { ".webm", "video/webm" }, { ".mp3", "audio/mpeg" },
            { ".wav", "audio/wav" }, { ".ogg", "audio/ogg" }, { ".m4a", "audio/mp4" }
        };

        void ServeLocalMedia(CoreWebView2WebResourceRequestedEventArgs e, Uri u)
        {
            string root;
            if (!hostRoots.TryGetValue(u.Host, out root))
            {
                e.Response = coreEnv.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            string full;
            string type;
            try
            {
                string rel = Uri.UnescapeDataString(u.AbsolutePath).TrimStart('/').Replace('/', '\\');
                full = Path.GetFullPath(Path.Combine(root, rel));
                if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new UnauthorizedAccessException();
                if (!MediaTypes.TryGetValue(Path.GetExtension(full) ?? "", out type)) throw new UnauthorizedAccessException();
            }
            catch
            {
                e.Response = coreEnv.CreateWebResourceResponse(null, 403, "Forbidden", "");
                return;
            }
            string headers = "Content-Type: " + type + "\r\nX-Content-Type-Options: nosniff\r\nCache-Control: no-cache";
            if (type == "image/svg+xml") headers += "\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src data:";

            // 在背景讀檔，避免大圖片卡住畫面
            CoreWebView2Deferral deferral = e.GetDeferral();
            Task.Run(() =>
            {
                FileInfo fi = new FileInfo(full);
                if (!fi.Exists || fi.Length > MaxFileBytes) return (byte[])null;
                return File.ReadAllBytes(full);
            }).ContinueWith(t =>
            {
                try
                {
                    if (t.IsFaulted || t.Result == null) e.Response = coreEnv.CreateWebResourceResponse(null, 404, "Not Found", "");
                    else e.Response = coreEnv.CreateWebResourceResponse(new MemoryStream(t.Result), 200, "OK", headers);
                }
                catch { }
                finally { deferral.Complete(); }
            }, TaskScheduler.FromCurrentSynchronizationContext());
        }

        string MapRoot(string root)
        {
            string host;
            if (root.Length >= 2 && root[1] == ':')
            {
                host = char.ToLowerInvariant(root[0]) + DriveHostSuffix;
            }
            else
            {
                string key = root.TrimEnd('\\');
                if (!uncHosts.TryGetValue(key, out host))
                {
                    host = "unc" + (uncHosts.Count + 1) + DriveHostSuffix;
                    uncHosts[key] = host;
                }
            }
            hostRoots[host] = root.EndsWith("\\") ? root : root + "\\";
            return host;
        }

        string BaseUrlFor(string dir)
        {
            try
            {
                string root = Path.GetPathRoot(dir);
                if (string.IsNullOrEmpty(root)) return null;
                if (!root.EndsWith("\\")) root += "\\";
                string host = MapRoot(root);
                string rel = dir.Length > root.Length ? dir.Substring(root.Length) : "";
                StringBuilder sb = new StringBuilder("https://" + host + "/");
                foreach (string part in rel.Split(new[] { '\\' }, StringSplitOptions.RemoveEmptyEntries))
                    sb.Append(Uri.EscapeDataString(part)).Append('/');
                return sb.ToString();
            }
            catch
            {
                return null;
            }
        }

        /* ================= 網頁 → 主程式 的訊息 ================= */

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            // 只接受程式自己的網頁送來的訊息
            if (e.Source == null || !e.Source.StartsWith("https://" + AppHost + "/", StringComparison.OrdinalIgnoreCase)) return;
            Dictionary<string, object> msg;
            try { msg = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
            catch { return; }
            if (msg == null) return;

            switch (Str(msg, "cmd"))
            {
                case "ready":
                    pageReady = true;
                    remoteAlways = Bool(msg, "remoteAlways");
                    if (pendingPath != null)
                    {
                        string p = pendingPath;
                        pendingPath = null;
                        LoadFile(p, false, null);
                    }
                    else
                    {
                        Send("{\"type\":\"home\"}");
                        if (crashNotice)
                        {
                            crashNotice = false;
                            Toast("這個檔案讓顯示元件當掉了，已停止自動重新開啟", null);
                        }
                    }
                    break;
                case "open": ShowOpenDialog(); break;
                case "openPath":
                    {
                        string p = Str(msg, "path");
                        if (IsBlockedNetworkPath(p) && !ConfirmNetworkOpen(p)) break;
                        LoadFile(p, false, null);
                    }
                    break;
                case "reload": if (currentPath != null) { lastText = null; LoadFile(currentPath, true, null); } break;
                case "link": HandleLink(Str(msg, "href")); break;
                case "files": HandleDroppedFiles(e); break;
                case "revealPath":
                    {
                        string p = Str(msg, "path");
                        if (!IsBlockedNetworkPath(p)) Reveal(p);
                    }
                    break;
                case "remote": // 使用者在提示列按「載入這次」或「一律載入」
                    if (Str(msg, "mode") == "always") remoteAlways = true;
                    else remoteAllowedForDoc = true;
                    if (currentPath != null) { lastText = null; LoadFile(currentPath, true, null); }
                    break;
                case "remotePref":
                    remoteAlways = Bool(msg, "always");
                    if (remoteAlways && currentPath != null) { lastText = null; LoadFile(currentPath, true, null); }
                    break;
                case "print":
                    try { core.ShowPrintUI(CoreWebView2PrintDialogKind.Browser); }
                    catch { core.ExecuteScriptAsync("window.print()"); }
                    break;
                case "pdf": ExportPdf(); break;
                case "zoom": Zoom(msg); break;
                case "theme":
                    darkTheme = Bool(msg, "dark");
                    ApplyBackground();
                    web.DefaultBackgroundColor = BackColor;
                    ApplyTitleBar();
                    break;
                case "close":
                    StopWatching();
                    currentPath = null;
                    lastText = null;
                    Text = AppTitle;
                    break;
            }
        }

        void OnNavigationStarting(object sender, CoreWebView2NavigationStartingEventArgs e)
        {
            string uri = e.Uri ?? "";
            if (uri.StartsWith("https://" + AppHost + "/", StringComparison.OrdinalIgnoreCase))
            {
                pageReady = false;
                return;
            }
            e.Cancel = true;
            if (uri.StartsWith("file:", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    string p = new Uri(uri).LocalPath;
                    if (IsMarkdown(p) && !IsBlockedNetworkPath(p)) LoadFile(p, false, null);
                }
                catch { }
                return;
            }
            OpenExternal(uri);
        }

        /* ================= 讀檔與顯示 ================= */

        void LoadFile(string path, bool reload, string hash)
        {
            if (string.IsNullOrEmpty(path)) return;
            if (!pageReady || core == null)
            {
                pendingPath = path;
                return;
            }

            string full;
            try { full = Path.GetFullPath(path.Trim('"')); }
            catch
            {
                Send("{\"type\":\"notfound\",\"path\":" + J(path) + "}");
                return;
            }

            if (!File.Exists(full))
            {
                if (!reload) Send("{\"type\":\"notfound\",\"path\":" + J(full) + "}");
                return;
            }

            FileInfo fi = new FileInfo(full);
            if (fi.Length > MaxFileBytes)
            {
                Toast("檔案太大（超過 64 MB），無法開啟", null);
                return;
            }

            string text;
            try { text = ReadText(full); }
            catch (Exception ex)
            {
                if (!reload) Toast("無法讀取檔案：" + ex.Message, null);
                return;
            }

            bool sameFile = string.Equals(full, currentPath, StringComparison.OrdinalIgnoreCase);
            if (reload && sameFile && text == lastText) return; // 內容沒變就不重畫
            if (!sameFile) remoteAllowedForDoc = false; // 換文件就重新詢問網路圖片
            remoteBlocked = 0;
            if (crashedPath != null && !string.Equals(full, crashedPath, StringComparison.OrdinalIgnoreCase)) crashedPath = null;

            string dir = Path.GetDirectoryName(full);
            currentPath = full;
            lastText = text;
            Text = Path.GetFileName(full) + " - " + AppTitle;

            StringBuilder sb = new StringBuilder(text.Length + 512);
            sb.Append("{\"type\":\"load\"");
            sb.Append(",\"path\":").Append(J(full));
            sb.Append(",\"name\":").Append(J(Path.GetFileName(full)));
            sb.Append(",\"dir\":").Append(J(dir));
            sb.Append(",\"base\":").Append(J(BaseUrlFor(dir)));
            sb.Append(",\"mtime\":").Append(J(fi.LastWriteTime.ToString("yyyy/MM/dd HH:mm")));
            if (!string.IsNullOrEmpty(hash)) sb.Append(",\"hash\":").Append(J(hash));
            sb.Append(",\"reload\":").Append(reload && sameFile ? "true" : "false");
            sb.Append(",\"text\":").Append(J(text));
            sb.Append('}');
            Send(sb.ToString());

            if (!sameFile || watcher == null) Watch(full);
        }

        static string ReadText(string path)
        {
            byte[] data = null;
            for (int i = 0; ; i++)
            {
                try
                {
                    using (FileStream fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                    {
                        data = new byte[fs.Length];
                        int off = 0;
                        while (off < data.Length)
                        {
                            int n = fs.Read(data, off, data.Length - off);
                            if (n <= 0) break;
                            off += n;
                        }
                    }
                    break;
                }
                catch (IOException)
                {
                    if (i >= 6) throw;
                    Thread.Sleep(80);
                }
            }
            return Decode(data);
        }

        static string Decode(byte[] b)
        {
            if (b.Length >= 3 && b[0] == 0xEF && b[1] == 0xBB && b[2] == 0xBF) return new UTF8Encoding(false).GetString(b, 3, b.Length - 3);
            if (b.Length >= 2 && b[0] == 0xFF && b[1] == 0xFE) return Encoding.Unicode.GetString(b, 2, b.Length - 2);
            if (b.Length >= 2 && b[0] == 0xFE && b[1] == 0xFF) return Encoding.BigEndianUnicode.GetString(b, 2, b.Length - 2);
            try
            {
                return new UTF8Encoding(false, true).GetString(b);
            }
            catch (DecoderFallbackException)
            {
                // 不是 UTF-8，改用系統編碼（繁中 Windows 為 Big5）
                return Encoding.Default.GetString(b);
            }
        }

        /* ================= 檔案變更自動重新載入 ================= */

        void Watch(string path)
        {
            StopWatching();
            try
            {
                watcher = new FileSystemWatcher(Path.GetDirectoryName(path), Path.GetFileName(path));
                watcher.NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName | NotifyFilters.CreationTime;
                watcher.SynchronizingObject = this;
                FileSystemEventHandler onChange = (s, e) => { reloadTimer.Stop(); reloadTimer.Start(); };
                watcher.Changed += onChange;
                watcher.Created += onChange;
                watcher.Renamed += (s, e) =>
                {
                    if (string.Equals(e.FullPath, currentPath, StringComparison.OrdinalIgnoreCase))
                    {
                        reloadTimer.Stop();
                        reloadTimer.Start();
                    }
                };
                watcher.EnableRaisingEvents = true;
            }
            catch
            {
                watcher = null;
            }
        }

        void StopWatching()
        {
            if (watcher == null) return;
            try { watcher.EnableRaisingEvents = false; watcher.Dispose(); } catch { }
            watcher = null;
        }

        /* ================= 各種動作 ================= */

        void ShowOpenDialog()
        {
            using (OpenFileDialog dlg = new OpenFileDialog())
            {
                dlg.Title = "開啟 Markdown 檔案";
                dlg.Filter = "Markdown 檔案 (*.md;*.markdown;*.txt)|*.md;*.markdown;*.mdown;*.mkd;*.mkdn;*.mdwn;*.txt|所有檔案 (*.*)|*.*";
                dlg.RestoreDirectory = true; // 不要讓對話框改掉程式的「目前資料夾」
                if (currentPath != null) dlg.InitialDirectory = Path.GetDirectoryName(currentPath);
                if (dlg.ShowDialog(this) == DialogResult.OK) LoadFile(dlg.FileName, false, null);
            }
        }

        void HandleDroppedFiles(CoreWebView2WebMessageReceivedEventArgs e)
        {
            string md = null, any = null;
            try
            {
                foreach (object o in e.AdditionalObjects)
                {
                    CoreWebView2File f = o as CoreWebView2File;
                    if (f == null) continue;
                    if (any == null) any = f.Path;
                    if (IsMarkdown(f.Path)) { md = f.Path; break; }
                }
            }
            catch { }
            if (md != null) { LoadFile(md, false, null); return; }
            if (any != null) Toast("請拖曳 Markdown 檔（.md）進來", null);
        }

        void HandleLink(string href)
        {
            if (string.IsNullOrEmpty(href)) return;
            string lower = href.ToLowerInvariant();
            if (lower.StartsWith("http://") || lower.StartsWith("https://") || lower.StartsWith("mailto:"))
            {
                OpenExternal(href);
                return;
            }

            string pathPart = href;
            string hash = null;
            int hi = pathPart.IndexOf('#');
            if (hi >= 0) { hash = pathPart.Substring(hi + 1); pathPart = pathPart.Substring(0, hi); }
            int qi = pathPart.IndexOf('?');
            if (qi >= 0) pathPart = pathPart.Substring(0, qi);

            bool isFileUri = lower.StartsWith("file:");
            bool isDrive = pathPart.Length > 2 && char.IsLetter(pathPart[0]) && pathPart[1] == ':';
            if (!isFileUri && !isDrive && System.Text.RegularExpressions.Regex.IsMatch(pathPart, "^[a-zA-Z][a-zA-Z0-9+.-]*:")) return; // 其他協定一律忽略

            if (pathPart.Length == 0)
            {
                if (hash != null) Send("{\"type\":\"hash\",\"hash\":" + J(hash) + "}");
                return;
            }

            string target;
            try
            {
                if (isFileUri) target = new Uri(pathPart).LocalPath;
                else
                {
                    string rel = Uri.UnescapeDataString(pathPart).Replace('/', '\\');
                    if (isDrive) target = Path.GetFullPath(rel);
                    else
                    {
                        if (currentPath == null) return;
                        target = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(currentPath), rel.TrimStart('\\')));
                    }
                }
            }
            catch
            {
                return;
            }

            if (IsBlockedNetworkPath(target))
            {
                Toast("基於安全考量，不開啟指向其他電腦（網路路徑）的連結", null);
                return;
            }
            if (Directory.Exists(target))
            {
                Reveal(target);
                return;
            }
            if (!File.Exists(target))
            {
                Toast("找不到連結的檔案：" + Path.GetFileName(target), null);
                return;
            }
            if (IsMarkdown(target)) LoadFile(target, false, hash);
            else Reveal(target); // 其他檔案只在檔案總管中標示，不直接執行
        }

        // 從「最近開啟」或「上一份」要開網路上的檔案時，先用 Windows 原生視窗問過使用者
        bool ConfirmNetworkOpen(string path)
        {
            return MessageBox.Show(this,
                "要開啟網路上的這個檔案嗎？\n\n" + path + "\n\n只有在你信任這台電腦時才按「是」。",
                AppTitle, MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2) == DialogResult.Yes;
        }

        // 文件裡的連結若指向 \\伺服器\分享 這類網路路徑，光是檢查檔案存在，
        // Windows 就會自動連過去並送出登入憑證（NTLM），所以一律擋下。
        // 例外：目前開的文件本身就在同一個網路分享上（使用者自己選的）。
        bool IsBlockedNetworkPath(string target)
        {
            if (string.IsNullOrEmpty(target) || !target.StartsWith(@"\\")) return false;
            if (currentPath != null && currentPath.StartsWith(@"\\"))
            {
                try
                {
                    if (string.Equals(Path.GetPathRoot(currentPath), Path.GetPathRoot(target), StringComparison.OrdinalIgnoreCase))
                        return false;
                }
                catch { }
            }
            return true;
        }

        static bool IsMarkdown(string path)
        {
            string ext = (Path.GetExtension(path) ?? "").ToLowerInvariant();
            return Array.IndexOf(MarkdownExts, ext) >= 0;
        }

        static void OpenExternal(string uri)
        {
            if (string.IsNullOrEmpty(uri)) return;
            Uri u;
            if (!Uri.TryCreate(uri, UriKind.Absolute, out u)) return;
            if (u.Scheme != Uri.UriSchemeHttp && u.Scheme != Uri.UriSchemeHttps && u.Scheme != Uri.UriSchemeMailto) return;
            // 用整理過的網址（引號、空白都會被編碼），避免夾帶額外參數給瀏覽器
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch { }
        }

        // 一律用完整路徑啟動 Windows 的檔案總管，不讓同資料夾的假 explorer.exe 有機會被執行
        static void Reveal(string path)
        {
            if (string.IsNullOrEmpty(path) || path.IndexOf('"') >= 0) return;
            try
            {
                string args;
                if (File.Exists(path)) args = "/select,\"" + path + "\"";
                else if (Directory.Exists(path)) args = "\"" + path + "\"";
                else return;
                ProcessStartInfo psi = new ProcessStartInfo(ExplorerExe, args);
                psi.UseShellExecute = false;
                psi.WorkingDirectory = Environment.SystemDirectory;
                Process.Start(psi);
            }
            catch { }
        }

        async void ExportPdf()
        {
            if (currentPath == null || core == null) return;
            string file;
            using (SaveFileDialog dlg = new SaveFileDialog())
            {
                dlg.Title = "匯出成 PDF";
                dlg.Filter = "PDF 檔案 (*.pdf)|*.pdf";
                dlg.FileName = Path.GetFileNameWithoutExtension(currentPath) + ".pdf";
                dlg.InitialDirectory = Path.GetDirectoryName(currentPath);
                dlg.OverwritePrompt = true;
                dlg.RestoreDirectory = true;
                if (dlg.ShowDialog(this) != DialogResult.OK) return;
                file = dlg.FileName;
            }
            try
            {
                CoreWebView2PrintSettings ps = core.Environment.CreatePrintSettings();
                ps.ShouldPrintBackgrounds = true;
                ps.ShouldPrintHeaderAndFooter = false;
                ps.MarginTop = 0.6;
                ps.MarginBottom = 0.6;
                ps.MarginLeft = 0.55;
                ps.MarginRight = 0.55;
                Toast("正在匯出 PDF…", null);
                bool ok = await core.PrintToPdfAsync(file, ps);
                if (ok) Toast("已匯出 PDF：" + Path.GetFileName(file), file);
                else Toast("匯出 PDF 失敗", null);
            }
            catch (Exception ex)
            {
                Toast("匯出 PDF 失敗：" + ex.Message, null);
            }
        }

        void Zoom(Dictionary<string, object> msg)
        {
            int d = Int(msg, "d");
            double z = web.ZoomFactor;
            if (d == 0) z = 1.0;
            else
            {
                int idx = 0;
                double best = double.MaxValue;
                for (int i = 0; i < ZoomSteps.Length; i++)
                {
                    double diff = Math.Abs(ZoomSteps[i] - z);
                    if (diff < best) { best = diff; idx = i; }
                }
                idx = Math.Max(0, Math.Min(ZoomSteps.Length - 1, idx + (d > 0 ? 1 : -1)));
                z = ZoomSteps[idx];
            }
            web.ZoomFactor = z;
            Toast("縮放 " + Math.Round(z * 100) + "%", null);
        }

        void Toast(string message, string revealPath)
        {
            string s = "{\"type\":\"toast\",\"message\":" + J(message);
            if (revealPath != null) s += ",\"reveal\":" + J(revealPath);
            Send(s + "}");
        }

        void Send(string jsonText)
        {
            if (core == null) return;
            try { core.PostWebMessageAsJson(jsonText); } catch { }
        }

        /* ================= 外觀：背景色、標題列 ================= */

        void ApplyBackground()
        {
            BackColor = darkTheme ? Color.FromArgb(38, 38, 36) : Color.FromArgb(250, 249, 245);
        }

        [DllImport("dwmapi.dll")]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
        static extern IntPtr LoadLibrary(string path);

        void ApplyTitleBar()
        {
            if (!IsHandleCreated) return;
            try
            {
                int dark = darkTheme ? 1 : 0;
                DwmSetWindowAttribute(Handle, 20, ref dark, 4); // 深色標題列
                int cap = darkTheme ? Rgb(38, 38, 36) : Rgb(250, 249, 245);
                DwmSetWindowAttribute(Handle, 35, ref cap, 4); // 標題列底色（Win11）
                int txt = darkTheme ? Rgb(236, 235, 228) : Rgb(41, 38, 27);
                DwmSetWindowAttribute(Handle, 36, ref txt, 4); // 標題文字顏色（Win11）
            }
            catch { }
        }

        static int Rgb(int r, int g, int b) { return r | (g << 8) | (b << 16); }

        [StructLayout(LayoutKind.Sequential)]
        struct RECT { public int Left, Top, Right, Bottom; }

        protected override void WndProc(ref Message m)
        {
            const int WM_DPICHANGED = 0x02E0;
            if (m.Msg == WM_DPICHANGED)
            {
                RECT r = (RECT)Marshal.PtrToStructure(m.LParam, typeof(RECT));
                SetBounds(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
            }
            base.WndProc(ref m);
        }

        /* ================= 記住視窗位置 ================= */

        static string BoundsFile { get { return Path.Combine(DataDir, "window.txt"); } }

        void LoadWindowBounds()
        {
            float scale = DeviceDpi / 96f;
            Rectangle wa = Screen.PrimaryScreen.WorkingArea;
            int w = (int)Math.Min(1200 * scale, wa.Width * 0.9);
            int h = (int)Math.Min(880 * scale, wa.Height * 0.9);
            Bounds = new Rectangle(wa.Left + (wa.Width - w) / 2, wa.Top + (wa.Height - h) / 2, w, h);
            MinimumSize = new Size((int)(460 * scale), (int)(360 * scale));
            darkTheme = SystemPrefersDark();
            try
            {
                if (!File.Exists(BoundsFile)) return;
                string[] p = File.ReadAllText(BoundsFile).Trim().Split(',');
                if (p.Length < 5) return;
                Rectangle r = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
                bool visible = false;
                foreach (Screen s in Screen.AllScreens)
                {
                    Rectangle inter = Rectangle.Intersect(s.WorkingArea, r);
                    if (inter.Width > 120 && inter.Height > 80) { visible = true; break; }
                }
                if (visible && r.Width >= 300 && r.Height >= 200) Bounds = r;
                if (p[4] == "1") WindowState = FormWindowState.Maximized;
                if (p.Length >= 6) darkTheme = p[5] == "dark";
            }
            catch { }
        }

        void SaveWindowBounds()
        {
            try
            {
                Rectangle r = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                Directory.CreateDirectory(DataDir);
                File.WriteAllText(BoundsFile, string.Join(",", new[] {
                    r.X.ToString(), r.Y.ToString(), r.Width.ToString(), r.Height.ToString(),
                    WindowState == FormWindowState.Maximized ? "1" : "0",
                    darkTheme ? "dark" : "light" }));
            }
            catch { }
        }

        static bool SystemPrefersDark()
        {
            try
            {
                object v = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize", "AppsUseLightTheme", 1);
                return v is int && (int)v == 0;
            }
            catch { return false; }
        }

        /* ================= JSON 小工具 ================= */

        static string Str(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v != null ? v.ToString() : null;
        }

        static bool Bool(Dictionary<string, object> d, string k)
        {
            object v;
            return d.TryGetValue(k, out v) && v is bool && (bool)v;
        }

        static int Int(Dictionary<string, object> d, string k)
        {
            object v;
            if (!d.TryGetValue(k, out v) || v == null) return 0;
            try { return Convert.ToInt32(v); } catch { return 0; }
        }

        static string J(string s)
        {
            if (s == null) return "null";
            StringBuilder sb = new StringBuilder(s.Length + 16);
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20 || c == (char)0x2028 || c == (char)0x2029 || char.IsSurrogate(c))
                            sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else
                            sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}
