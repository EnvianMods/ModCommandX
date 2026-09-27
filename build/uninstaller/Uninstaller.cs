// Uninstall Mod Command X — a small standalone WinForms uninstaller.
//
// Compiled by build/build-uninstaller.js with the C# compiler that ships with
// the .NET Framework 4.x inside every Windows 10/11 (csc.exe, C# 5), so it
// needs no extra runtime, no admin rights and no second Electron. It is not
// part of the Electron app on purpose: it has to delete the app's own exe and
// the %TEMP%\ModCommandX folder the portable app runs from.
//
// What it removes is read from the app's code, not guessed (see README
// "Uninstalling"):
//   %APPDATA%\ModCommandX          settings (manager-data.json), staging,
//                                  nexus-file-index.json, tools\retoc.exe
//   %APPDATA%\Mod Command X        Electron profile (Partitions\nexus cookies, caches)
//   %TEMP%\ModCommandX             the portable exe's unpack folder
//   <source checkout>\data         dev-run data (npm start / npx electron .)
//   ModCommandX.exe + this exe     when run from the release folder (self-delete)
//   HKCU\Software\Classes\nxm      only when it points at a Mod Command X exe
//   Steam update freeze            undone exactly like Settings -> freeze off
// The mod library (library / backups / versions) is kept unless the user ticks
// the box, and in an archive shared with the upstream Mod Command only the
// entries X alone uses are ever touched. Deployed mods in the game, mods.txt,
// enabled.txt markers, UE4SS and *.zcbak config originals are never touched.
//
// Every path used can be redirected for sandbox tests (--appdata, --temp,
// --game, --reg-classes, --steam-root, ...); --dry-run / --yes / --report run
// it headless. See Options below.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: System.Reflection.AssemblyTitle("Uninstall Mod Command X")]
[assembly: System.Reflection.AssemblyProduct("Mod Command X")]
[assembly: System.Reflection.AssemblyDescription("Removes Mod Command X; leaves installed mods in the game untouched")]

namespace ModCommandXUninstaller
{
    static class K
    {
        public const string Product = "Mod Command X";
        public const string DataDirName = "ModCommandX";            // main.js APPDATA_DIR_NAME
        public const string ProfileDirName = "Mod Command X";       // Electron userData = package.json productName
        public const string UnpackDirName = "ModCommandX";          // package.json build.portable.unpackDirName
        public const string XArchiveDirName = BuildInfo.OldXArchiveDirName; // X's own archive before it shared Mod Command's
        public const string UpstreamArchiveDirName = "ModCommandArchive";
        public const string UpstreamLegacyArchiveDirName = "ZeroCompanyModArchive";
        public const string UpstreamDataDirName = "ZeroCompanyModCommand";
        public const string AppExeName = "ModCommandX.exe";
        public const string UnpackedExeName = "Mod Command X.exe";
        public const string UninstallerExeName = "Uninstall Mod Command X.exe";
        public const string InAppCopyDirName = "ModCommandX-uninstaller"; // where the app puts its embedded copy
        public const string LogName = "ModCommandX-uninstall.log";
        public const string XPackageName = "mod-command-x";
        public const string AppId = "2075800";
        public static readonly string GameExeRel = @"SWZeroCompany\Binaries\Win64\SWZeroCompany.exe";
        public static readonly string[] SecretKeys = { "nexusApiKey", "nexusApiKeyEncrypted", "nexusOAuth", "nexusOAuthEncrypted" };
        public static readonly string[] LibrarySubdirs = { "library", "backups", "versions" };
        // lib/storage.js MIRROR_FILE / X_BLOCK: the shared archive's manifest
        // mirror, and X's own bookkeeping block inside it.
        public const string MirrorFile = "manager-data.json";
        public const string XBlock = "modCommandX";
    }

    // ------------------------------------------------------------------ options
    class Options
    {
        public string AppData, LocalAppData, Temp, UserProfile, Game, SteamRoot, AppExe, InstallDir, DevDir, LogPath, ReportPath, Screenshot;
        public string RegClasses = @"Software\Classes";
        public bool DryRun, Yes, DeleteLibrary, CloseRunning, NoSelfDelete, Json, NoSteamRegistry;
        public List<string> ProcessNames;
        public bool ProcessNamesOverridden;
        public int WaitPid;
        public string SelfExe;

        public bool Headless { get { return DryRun || Yes; } }

        public static Options Parse(string[] args)
        {
            var o = new Options();
            o.AppData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            o.LocalAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            o.Temp = Path.GetTempPath();
            o.UserProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            o.ProcessNames = new List<string> { "ModCommandX", "Mod Command X" };
            o.SelfExe = Application.ExecutablePath;
            for (int i = 0; i < args.Length; i++)
            {
                string a = args[i];
                Func<string> next = () => { if (i + 1 >= args.Length) throw new ArgumentException(a + " needs a value"); return args[++i]; };
                switch (a.ToLowerInvariant())
                {
                    case "--appdata": o.AppData = next(); break;
                    case "--localappdata": o.LocalAppData = next(); break;
                    case "--temp": o.Temp = next(); break;
                    case "--userprofile": o.UserProfile = next(); break;
                    case "--game": o.Game = next(); break;
                    case "--steam-root": o.SteamRoot = next(); break;
                    case "--no-steam-registry": o.NoSteamRegistry = true; break;
                    case "--reg-classes": o.RegClasses = next().Trim('\\'); break;
                    case "--app-exe": o.AppExe = next(); break;
                    case "--install-dir": o.InstallDir = next(); break;
                    case "--dev-dir": o.DevDir = next(); break;
                    case "--log": o.LogPath = next(); break;
                    case "--report": o.ReportPath = next(); break;
                    case "--screenshot": o.Screenshot = next(); break;
                    case "--process-names":
                        o.ProcessNames = next().Split(',').Select(s => s.Trim()).Where(s => s.Length > 0).ToList();
                        o.ProcessNamesOverridden = true; break;
                    case "--wait-pid": o.WaitPid = int.Parse(next()); break;
                    case "--dry-run": o.DryRun = true; break;
                    case "--yes": o.Yes = true; break;
                    case "--json": o.Json = true; break;
                    case "--delete-library": o.DeleteLibrary = true; break;
                    case "--close-running": o.CloseRunning = true; break;
                    case "--no-self-delete": o.NoSelfDelete = true; break;
                    default: throw new ArgumentException("Unknown option " + a);
                }
            }
            if (o.LogPath == null) o.LogPath = Path.Combine(o.Temp, K.LogName);
            // Registry redirection is for sandbox tests only: it must stay under HKCU.
            if (o.RegClasses.StartsWith("HKCU\\", StringComparison.OrdinalIgnoreCase)) o.RegClasses = o.RegClasses.Substring(5);
            if (o.RegClasses.StartsWith("HKEY_CURRENT_USER\\", StringComparison.OrdinalIgnoreCase)) o.RegClasses = o.RegClasses.Substring(18);
            return o;
        }
    }

    // ------------------------------------------------------------------ JSON
    static class J
    {
        static readonly JavaScriptSerializer S = new JavaScriptSerializer { MaxJsonLength = int.MaxValue, RecursionLimit = 512 };

        public static Dictionary<string, object> ReadFile(string p)
        {
            try
            {
                if (!File.Exists(p)) return null;
                return S.DeserializeObject(File.ReadAllText(p, Encoding.UTF8)) as Dictionary<string, object>;
            }
            catch { return null; }
        }
        public static Dictionary<string, object> Obj(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null;
        }
        public static object[] Arr(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v is object[] ? (object[])v : new object[0];
        }
        public static string Str(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v is string ? (string)v : null;
        }
        public static bool Bool(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v is bool && (bool)v;
        }
        public static bool Has(Dictionary<string, object> d, string k) { return d != null && d.ContainsKey(k); }
        public static string Serialize(object o) { return S.Serialize(o); }
    }

    // One mod record from a manager-data.json (X's or the upstream app's).
    class ModRec
    {
        public string Id, Name, MetaTitle, ModType;
        public bool Enabled, HasBackups;
        public string VaultKey { get { return ModType + "-" + Util.SafeName(string.IsNullOrEmpty(MetaTitle) ? Name : MetaTitle).ToLowerInvariant(); } }
    }

    class ManagerData
    {
        public string File;
        public Dictionary<string, object> Raw;
        public Dictionary<string, object> Settings;
        public List<ModRec> Mods = new List<ModRec>();
        public HashSet<string> ProfileVaultKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        public static ManagerData Load(string file) { return FromRaw(J.ReadFile(file), file); }

        public static ManagerData FromRaw(Dictionary<string, object> raw, string file)
        {
            if (raw == null) return null;
            var md = new ManagerData { File = file, Raw = raw, Settings = J.Obj(raw, "settings") ?? new Dictionary<string, object>() };
            foreach (var o in J.Arr(raw, "mods"))
            {
                var m = o as Dictionary<string, object>;
                if (m == null || J.Str(m, "id") == null) continue;
                md.Mods.Add(new ModRec
                {
                    Id = J.Str(m, "id"),
                    Name = J.Str(m, "name") ?? J.Str(m, "id"),
                    MetaTitle = J.Str(m, "metaTitle"),
                    ModType = J.Str(m, "modType") ?? "",
                    Enabled = J.Bool(m, "enabled"),
                    HasBackups = J.Arr(m, "backups").Length > 0,
                });
            }
            foreach (var p in J.Arr(raw, "profiles"))
                foreach (var e in J.Arr(p as Dictionary<string, object>, "entries"))
                {
                    var key = J.Str(e as Dictionary<string, object>, "vaultKey");
                    if (key != null) md.ProfileVaultKeys.Add(key);
                }
            return md;
        }
        public string GamePath { get { return J.Str(Settings, "gamePath"); } }
        public string StorageDir { get { return J.Str(Settings, "storageDir"); } }
        public bool UpdateFreeze { get { return J.Bool(Settings, "updateFreeze"); } }
    }

    // Port of lib/storage.js mirrorUpstreamIds(): the ids the MAIN app references
    // according to a mirror - every record when upstream wrote it last (no X
    // block), else the upstreamIds X carried forward when it last wrote it.
    static class Mirror
    {
        public static HashSet<string> UpstreamIds(Dictionary<string, object> mirror)
        {
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (mirror == null) return ids;
            var block = J.Obj(mirror, K.XBlock);
            if (block != null) { foreach (var id in J.Arr(block, "upstreamIds")) ids.Add(Convert.ToString(id)); return ids; }
            foreach (var m in J.Arr(mirror, "mods"))
            {
                var id = J.Str(m as Dictionary<string, object>, "id");
                if (id != null) ids.Add(id);
            }
            return ids;
        }
    }

    // JSON text exactly as JavaScript's JSON.stringify(value, null, 2) writes it,
    // so the main app's records in a shared mirror keep their bytes.
    static class JsonText
    {
        static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;

        public static string Stringify(object v)
        {
            var sb = new StringBuilder();
            Write(sb, v, "");
            return sb.ToString();
        }

        static void Write(StringBuilder sb, object v, string indent)
        {
            if (v == null) { sb.Append("null"); return; }
            if (v is string) { Str(sb, (string)v); return; }
            if (v is bool) { sb.Append((bool)v ? "true" : "false"); return; }
            if (v is int || v is long || v is short || v is byte || v is uint || v is ulong) { sb.Append(Convert.ToString(v, Inv)); return; }
            if (v is decimal) { sb.Append(Num(((decimal)v).ToString(Inv))); return; }
            if (v is double || v is float)
            {
                double d = Convert.ToDouble(v);
                sb.Append(double.IsNaN(d) || double.IsInfinity(d) ? "null" : Num(d.ToString("R", Inv)));
                return;
            }
            var dict = v as IDictionary<string, object>;
            if (dict != null)
            {
                if (dict.Count == 0) { sb.Append("{}"); return; }
                string inner = indent + "  ";
                sb.Append("{\n");
                bool first = true;
                foreach (var kv in dict)
                {
                    if (!first) sb.Append(",\n");
                    first = false;
                    sb.Append(inner); Str(sb, kv.Key); sb.Append(": "); Write(sb, kv.Value, inner);
                }
                sb.Append("\n").Append(indent).Append("}");
                return;
            }
            var list = v as System.Collections.IEnumerable;
            if (list != null)
            {
                var items = list.Cast<object>().ToList();
                if (items.Count == 0) { sb.Append("[]"); return; }
                string inner = indent + "  ";
                sb.Append("[\n");
                for (int i = 0; i < items.Count; i++)
                {
                    if (i > 0) sb.Append(",\n");
                    sb.Append(inner); Write(sb, items[i], inner);
                }
                sb.Append("\n").Append(indent).Append("]");
                return;
            }
            Str(sb, Convert.ToString(v, Inv));
        }

        // JS never prints a trailing fractional zero ("1.50" -> 1.5, "2.0" -> 2).
        static string Num(string text)
        {
            if (text.Contains(".") && !text.Contains("E") && !text.Contains("e")) text = text.TrimEnd('0').TrimEnd('.');
            return text;
        }

        static void Str(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\b': sb.Append("\\b"); break;
                    case '\f': sb.Append("\\f"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }

    static class Util
    {
        public static string SafeName(string name)
        {
            string s = Regex.Replace(name ?? "", "[^A-Za-z0-9_-]+", "_");
            s = Regex.Replace(s, "^_+|_+$", "");
            if (s.Length > 60) s = s.Substring(0, 60);
            return s.Length == 0 ? "Mod" : s;
        }

        public static string Full(string p)
        {
            if (string.IsNullOrEmpty(p)) return null;
            try
            {
                string f = Path.GetFullPath(p);
                string root = Path.GetPathRoot(f);
                return f.Length > root.Length ? f.TrimEnd('\\', '/') : root;
            }
            catch { return null; }
        }

        public static bool Same(string a, string b)
        {
            a = Full(a); b = Full(b);
            return a != null && b != null && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsUnder(string child, string parent)
        {
            child = Full(child); parent = Full(parent);
            if (child == null || parent == null) return false;
            return child.StartsWith(parent.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsDriveRoot(string p)
        {
            p = Full(p);
            if (p == null) return true;
            string root = Path.GetPathRoot(p) ?? "";
            return string.Equals(p.TrimEnd('\\'), root.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsReparse(string p)
        {
            try { return (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0; } catch { return false; }
        }

        public static bool Exists(string p) { return File.Exists(p) || Directory.Exists(p); }

        // Size of a file or folder tree; never follows junctions / symlinks.
        public static long Size(string p)
        {
            try
            {
                var attr = File.GetAttributes(p);
                if ((attr & FileAttributes.ReparsePoint) != 0) return 0;
                if ((attr & FileAttributes.Directory) == 0) return new FileInfo(p).Length;
                long n = 0;
                foreach (var e in Directory.EnumerateFileSystemEntries(p)) n += Size(e);
                return n;
            }
            catch { return 0; }
        }

        // True when a folder holds no files anywhere below it.
        public static bool IsEmptyTree(string p)
        {
            try
            {
                if (IsReparse(p)) return false;
                foreach (var f in Directory.EnumerateFiles(p)) return false;
                foreach (var d in Directory.EnumerateDirectories(p)) if (!IsEmptyTree(d)) return false;
                return true;
            }
            catch { return false; }
        }

        public static string HumanSize(long n)
        {
            if (n < 0) return "";
            if (n < 1024) return n + " B";
            if (n < 1024 * 1024) return (n / 1024.0).ToString("0.#") + " KB";
            if (n < 1024L * 1024 * 1024) return (n / 1048576.0).ToString("0.#") + " MB";
            return (n / 1073741824.0).ToString("0.##") + " GB";
        }

        public static bool IsXSourceCheckout(string dir)
        {
            try
            {
                string pkg = Path.Combine(dir, "package.json");
                if (!File.Exists(pkg)) return false;
                var j = J.ReadFile(pkg);
                return j != null && J.Str(j, "name") == K.XPackageName;
            }
            catch { return false; }
        }

        public static string FirstLine(string file)
        {
            try { using (var r = new StreamReader(file)) return (r.ReadLine() ?? "").Trim(); } catch { return ""; }
        }
    }

    // ------------------------------------------------------------------ plan
    enum Act { Remove, Keep, Restore, Note, Warn }
    enum Kind { None, Dir, File, RegKey, Unfreeze, ScrubSettings, MirrorScrub }

    class PlanItem
    {
        public Act Action;
        public Kind Kind;
        public string Group;      // section heading in the UI
        public string Label;
        public string Path;       // file system path / registry path
        public string AllowRoot;  // the X-owned root this delete must stay inside
        public long Size = -1;
        public string Note;
        public bool Library;      // part of the stored mod library (checkbox-dependent)
        public string Result;     // after execution: "removed", "failed: ...", ...
        public List<string> RemoveIds; // MirrorScrub: X-only record ids to take out
    }

    class Plan
    {
        public List<PlanItem> Items = new List<PlanItem>();
        public bool DeleteLibrary;
        public string GamePath;
        public bool GameOk;
        public string GameProblem;
        public List<string> Forbidden = new List<string>();
        public List<string> LibraryLocations = new List<string>();
        public List<string> DisabledLostNames = new List<string>();   // lost if the box is ticked
        public int OriginalsLost;                                       // gamefolder originals lost if ticked
        public int SharedKept;                                          // entries the upstream app also uses
        public bool SharedArchive;
        public string SelfExeToDelete;
        public string SelfDirToRemove;
        public List<string> DataDirs = new List<string>();
        public List<ManagerData> XData = new List<ManagerData>();

        public IEnumerable<PlanItem> Removes { get { return Items.Where(i => i.Action == Act.Remove); } }
        public long RemoveBytes { get { return Removes.Where(i => i.Size > 0).Sum(i => i.Size); } }
    }

    class Planner
    {
        readonly Options o;
        readonly Dictionary<string, long> sizeCache = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        public Planner(Options opts) { o = opts; }

        long SizeOf(string p)
        {
            long n;
            if (!sizeCache.TryGetValue(p, out n)) { n = Util.Size(p); sizeCache[p] = n; }
            return n;
        }

        PlanItem Add(Plan plan, Act act, Kind kind, string group, string label, string path, string allowRoot, string note)
        {
            var it = new PlanItem { Action = act, Kind = kind, Group = group, Label = label, Path = path, AllowRoot = allowRoot, Note = note };
            if ((kind == Kind.Dir || kind == Kind.File) && path != null && Util.Exists(path)) it.Size = SizeOf(path);
            plan.Items.Add(it);
            return it;
        }

        public Plan Build(bool deleteLibrary)
        {
            var plan = new Plan { DeleteLibrary = deleteLibrary };
            string appData = Util.Full(o.AppData), localAppData = Util.Full(o.LocalAppData), temp = Util.Full(o.Temp);

            // Paths no delete may ever equal or contain.
            plan.Forbidden.AddRange(new[] {
                appData, localAppData, temp, Util.Full(o.UserProfile),
                Util.Full(Environment.GetFolderPath(Environment.SpecialFolder.Windows)),
                Util.Full(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles)),
                Util.Full(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86)),
                Util.Full(Path.Combine(appData, K.UpstreamDataDirName)),
                Util.Full(Path.Combine(appData, "Zero Company Mod Command")),
            }.Where(p => p != null));

            // ---- install folder (where ModCommandX.exe / this exe live)
            string selfExe = Util.Full(o.SelfExe);
            string selfDir = Util.Full(Path.GetDirectoryName(selfExe));
            string installDir = Util.Full(o.InstallDir ?? (o.AppExe != null ? Path.GetDirectoryName(o.AppExe) : selfDir));
            bool sourceCheckout = installDir != null && Util.IsXSourceCheckout(installDir);
            string devDir = Util.Full(o.DevDir ?? (sourceCheckout ? installDir : null));

            // ---- X's data dirs: %APPDATA%\ModCommandX (+ a source checkout's data\)
            var dataDirs = new List<string> { Util.Full(Path.Combine(appData, K.DataDirName)) };
            if (devDir != null && File.Exists(Path.Combine(devDir, "data", "manager-data.json")))
                dataDirs.Add(Util.Full(Path.Combine(devDir, "data")));
            foreach (var d in dataDirs)
            {
                var md = ManagerData.Load(Path.Combine(d, "manager-data.json"));
                if (md != null) plan.XData.Add(md);
            }
            plan.DataDirs.AddRange(dataDirs);

            // Every mod X knows, and every entry the upstream app knows.
            var xMods = plan.XData.SelectMany(m => m.Mods).GroupBy(m => m.Id).Select(g => g.First()).ToList();
            var xVaultKeys = new HashSet<string>(xMods.Select(m => m.VaultKey), StringComparer.OrdinalIgnoreCase);
            foreach (var md in plan.XData) xVaultKeys.UnionWith(md.ProfileVaultKeys);

            // ---- game folder
            string game = o.Game;
            if (game == null) foreach (var md in plan.XData) if (!string.IsNullOrEmpty(md.GamePath)) { game = md.GamePath; break; }
            plan.GamePath = Util.Full(game);
            if (game == null) plan.GameProblem = "No game folder is set in Mod Command X's settings, so nothing in a game folder is touched.";
            else if (plan.GamePath == null || Util.IsDriveRoot(plan.GamePath)) plan.GameProblem = "The game folder in the settings (" + game + ") is a drive root or not a valid path; game-side steps skipped.";
            else if (!Directory.Exists(plan.GamePath)) plan.GameProblem = "The game folder in the settings (" + game + ") does not exist; game-side steps skipped.";
            else if (!File.Exists(Path.Combine(plan.GamePath, K.GameExeRel))) plan.GameProblem = "The game folder in the settings (" + game + ") does not contain " + K.GameExeRel + "; it looks wrong, so game-side steps are skipped.";
            else if (plan.Forbidden.Any(f => Util.Same(f, plan.GamePath) || Util.IsUnder(f, plan.GamePath))) plan.GameProblem = "The game folder in the settings (" + game + ") is a system or profile folder; game-side steps skipped.";
            else plan.GameOk = true;
            if (plan.GameOk)
            {
                plan.Forbidden.Add(plan.GamePath);
                plan.Forbidden.Add(Util.Full(Path.Combine(plan.GamePath, K.UpstreamArchiveDirName)));
                plan.Forbidden.Add(Util.Full(Path.Combine(plan.GamePath, K.UpstreamLegacyArchiveDirName)));
                plan.Forbidden.Add(Util.Full(Path.Combine(plan.GamePath, "ZeroCompanyModManager")));
                plan.Forbidden.Add(Util.Full(Path.Combine(plan.GamePath, "SWZeroCompany")));
            }

            // Upstream references: its own settings + the manifest mirror of any shared archive.
            var upIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var upKeys = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var upData = ManagerData.Load(Path.Combine(appData, K.UpstreamDataDirName, "manager-data.json"));
            Action<ManagerData> addUp = (md) =>
            {
                if (md == null) return;
                foreach (var m in md.Mods) { upIds.Add(m.Id); upKeys.Add(m.VaultKey); }
                upKeys.UnionWith(md.ProfileVaultKeys);
            };
            addUp(upData);

            // ---- archive roots X uses
            var sharedRoots = new List<string>();
            var xOnlyArchives = new List<string>();
            foreach (var md in plan.XData)
            {
                string root = null;
                if (!string.IsNullOrEmpty(md.StorageDir)) root = Util.Full(md.StorageDir);
                else if (plan.GameOk) root = Util.Full(Path.Combine(plan.GamePath, BuildInfo.ArchiveDirName));
                if (root == null || dataDirs.Any(d => Util.Same(d, root))) continue;
                if (Util.IsDriveRoot(root) || plan.Forbidden.Any(f => Util.Same(f, root) && !Util.Same(f, Path.Combine(plan.GamePath ?? "?", K.UpstreamArchiveDirName)))) continue;
                bool xNamed = string.Equals(Path.GetFileName(root), K.XArchiveDirName, StringComparison.OrdinalIgnoreCase)
                              && string.IsNullOrEmpty(md.StorageDir);
                if (xNamed) { if (!xOnlyArchives.Any(r => Util.Same(r, root))) xOnlyArchives.Add(root); }
                else if (!sharedRoots.Any(r => Util.Same(r, root))) sharedRoots.Add(root);
            }
            if (plan.GameOk)
            {
                string legacy = Util.Full(Path.Combine(plan.GamePath, K.XArchiveDirName));
                if (Directory.Exists(legacy) && !xOnlyArchives.Any(r => Util.Same(r, legacy))) xOnlyArchives.Add(legacy);
            }
            // What the main app references in a shared archive: a port of
            // lib/storage.js upstreamRefs() + mirrorUpstreamIds(), taken as a UNION
            // (its manifest above, plus the mirror's records it owns: all of them
            // when it wrote the mirror last, else the X block's upstreamIds).
            // Anything either source names is kept.
            var xBlocks = new Dictionary<string, Dictionary<string, object>>(StringComparer.OrdinalIgnoreCase);
            var unreadable = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var r in sharedRoots)
            {
                string mf = Path.Combine(r, K.MirrorFile);
                var raw = J.ReadFile(mf);
                if (raw == null) { if (File.Exists(mf)) unreadable.Add(r); continue; }
                var block = J.Obj(raw, K.XBlock);
                if (block != null) xBlocks[r] = block;
                var ids = Mirror.UpstreamIds(raw);
                upIds.UnionWith(ids);
                var mirror = ManagerData.FromRaw(raw, mf);
                foreach (var m in mirror.Mods) if (ids.Contains(m.Id)) upKeys.Add(m.VaultKey);
                var xProfiles = new HashSet<string>(J.Arr(block, "profileIds").Select(Convert.ToString));
                foreach (var p in J.Arr(raw, "profiles"))
                {
                    var pd = p as Dictionary<string, object>;
                    if (pd == null || xProfiles.Contains(Convert.ToString(J.Has(pd, "id") ? pd["id"] : ""))) continue;
                    foreach (var e in J.Arr(pd, "entries")) { var k = J.Str(e as Dictionary<string, object>, "vaultKey"); if (k != null) upKeys.Add(k); }
                }
            }
            plan.SharedArchive = sharedRoots.Any(Directory.Exists);

            // ---- 1. app data dirs
            foreach (var d in dataDirs)
            {
                if (!Directory.Exists(d)) continue;
                string group = Util.Same(d, Path.Combine(appData, K.DataDirName)) ? "Settings & app data" : "Dev-run data (source checkout)";
                if (Util.IsReparse(d))
                {
                    Add(plan, Act.Remove, Kind.Dir, group, "Link to app data (the link only, not its target)", d, d, null);
                    continue;
                }
                var libSubs = K.LibrarySubdirs.Select(s => Path.Combine(d, s)).Where(Directory.Exists).ToList();
                bool libHasContent = libSubs.Any(s => !Util.IsEmptyTree(s));
                bool keepLib = libHasContent && !deleteLibrary;
                if (!keepLib)
                {
                    var it = Add(plan, Act.Remove, Kind.Dir, group, "Mod Command X app data" + (libHasContent ? " (including its mod library)" : ""), d, d,
                        "settings, Nexus sign-in data, download staging, file-index cache, retoc");
                    if (libHasContent) { it.Library = true; plan.LibraryLocations.Add(d); }
                    continue;
                }
                // Keep the library sub-folders; remove everything else one by one.
                bool storageIsHere = plan.XData.Any(md => Util.Same(Path.GetDirectoryName(md.File), d)
                                                          && string.IsNullOrEmpty(md.StorageDir) && !plan.GameOk);
                foreach (var e in Directory.EnumerateFileSystemEntries(d))
                {
                    string name = Path.GetFileName(e);
                    if (K.LibrarySubdirs.Contains(name, StringComparer.OrdinalIgnoreCase)) continue;
                    if (storageIsHere && name.Equals("manager-data.json", StringComparison.OrdinalIgnoreCase)) continue;
                    bool isDir = Directory.Exists(e);
                    Add(plan, Act.Remove, isDir ? Kind.Dir : Kind.File, group, name, e, d, null);
                }
                foreach (var s in libSubs)
                {
                    var it = Add(plan, Act.Keep, Kind.Dir, "Your mod library", "Stored mods (" + Path.GetFileName(s) + ")", s, d, "kept so a reinstall restores them");
                    it.Library = true;
                }
                plan.LibraryLocations.Add(d);
                if (storageIsHere)
                {
                    var it = Add(plan, Act.Keep, Kind.ScrubSettings, "Your mod library", "Mod list for the stored library (manager-data.json, sign-in data removed)",
                        Path.Combine(d, "manager-data.json"), d, "kept so a reinstall knows the stored mods; stored Nexus credentials are stripped from it");
                    it.Library = true;
                }
            }

            // ---- 2. Electron profile (+ any LocalAppData twin), portable unpack folder
            string profile = Path.Combine(appData, K.ProfileDirName);
            if (Directory.Exists(profile))
                Add(plan, Act.Remove, Kind.Dir, "Settings & app data", "Browser profile (embedded Nexus cookies, caches)", profile, profile, "includes Partitions\\nexus");
            string localProfile = Path.Combine(localAppData, K.ProfileDirName);
            if (Directory.Exists(localProfile)) Add(plan, Act.Remove, Kind.Dir, "Settings & app data", "Local browser cache", localProfile, localProfile, null);
            string localData = Path.Combine(localAppData, K.DataDirName);
            if (Directory.Exists(localData)) Add(plan, Act.Remove, Kind.Dir, "Settings & app data", "Local app data", localData, localData, null);
            string unpack = Path.Combine(temp, K.UnpackDirName);
            if (Directory.Exists(unpack)) Add(plan, Act.Remove, Kind.Dir, "Program files", "Unpacked app runtime (portable exe)", unpack, unpack, null);

            // ---- 3. game side: X's own archive folder(s)
            foreach (var root in xOnlyArchives)
            {
                if (!Directory.Exists(root)) continue;
                bool empty = Util.IsEmptyTree(root);
                if (empty)
                {
                    Add(plan, Act.Remove, Kind.Dir, "Mod archive", "Empty " + Path.GetFileName(root) + " folder", root, root, null);
                    continue;
                }
                plan.LibraryLocations.Add(root);
                if (deleteLibrary)
                {
                    var it = Add(plan, Act.Remove, Kind.Dir, "Your mod library", "Mod Command X's own mod archive (" + Path.GetFileName(root) + ")", root, root, "library, backups, versions and its manifest");
                    it.Library = true;
                }
                else
                {
                    var it = Add(plan, Act.Keep, Kind.Dir, "Your mod library", "Mod Command X's own mod archive (" + Path.GetFileName(root) + ")", root, root, "kept so a reinstall restores every mod from it");
                    it.Library = true;
                }
            }

            // ---- 3b. shared archive: only entries X alone uses
            foreach (var root in sharedRoots)
            {
                if (!Directory.Exists(root)) continue;
                plan.LibraryLocations.Add(root);
                bool unknown = unreadable.Contains(root);
                Add(plan, Act.Keep, Kind.None, "Your mod library", "Mod archive shared with Mod Command (" + Path.GetFileName(root) + ")", root, null,
                    unknown ? "its manager-data.json cannot be read, so nothing in it is removed"
                            : "the folder and its manager-data.json belong to Mod Command too and are never removed");
                Action<string, bool, string> entry = (path, upstreamUses, label) =>
                {
                    if (!Directory.Exists(path)) return;
                    if (upstreamUses || unknown)
                    {
                        plan.SharedKept++;
                        var k = Add(plan, Act.Keep, Kind.Dir, "Your mod library", label, path, null, "Mod Command also uses it - kept");
                        k.Library = true;
                        return;
                    }
                    var it = Add(plan, deleteLibrary ? Act.Remove : Act.Keep, Kind.Dir, "Your mod library", label, path, root,
                        deleteLibrary ? "used only by Mod Command X" : "kept so a reinstall restores it");
                    it.Library = true;
                };
                // X's mods: its own settings, plus the records its X block in the
                // mirror claims (covers an X whose app data is already gone).
                var rootMods = new List<ModRec>(xMods);
                var rootKeys = new HashSet<string>(xVaultKeys, StringComparer.OrdinalIgnoreCase);
                Dictionary<string, object> block;
                if (xBlocks.TryGetValue(root, out block))
                {
                    var claimed = new HashSet<string>(J.Arr(block, "modIds").Select(Convert.ToString));
                    var mirror = ManagerData.Load(Path.Combine(root, K.MirrorFile));
                    foreach (var m in mirror.Mods)
                        if (claimed.Contains(m.Id) && !rootMods.Any(x => x.Id == m.Id)) { rootMods.Add(m); rootKeys.Add(m.VaultKey); }
                }
                foreach (var m in rootMods)
                {
                    entry(Path.Combine(root, "library", m.Id), upIds.Contains(m.Id), "Stored mod: " + m.Name + (m.Enabled ? "" : " (switched off)"));
                    entry(Path.Combine(root, "backups", "gamefiles", m.Id), upIds.Contains(m.Id), "Original game files replaced by: " + m.Name);
                }
                foreach (var key in rootKeys)
                {
                    if (string.Equals(key, "ue4ss-runtime", StringComparison.OrdinalIgnoreCase)) continue; // runtime builds: never X's alone
                    entry(Path.Combine(root, "versions", key), upKeys.Contains(key), "Older versions: " + key);
                }
                // The mirror (manager-data.json) is shared: with the box ticked only
                // X's own part leaves it - the modCommandX block, X's profiles and the
                // records of the mods removed above. Mod Command's records stay as they are.
                if (block != null && !unknown)
                {
                    var it = Add(plan, deleteLibrary ? Act.Remove : Act.Keep, Kind.MirrorScrub, "Your mod library",
                        deleteLibrary ? "Mod Command X's entries in the shared mod list (the file itself stays)" : "Mod Command X's entries in the shared mod list",
                        Path.Combine(root, K.MirrorFile), root,
                        deleteLibrary ? "only X's block and X-only records are taken out; Mod Command's records stay byte-for-byte"
                                      : "kept so a reinstall restores the list");
                    it.Library = true;
                    it.RemoveIds = rootMods.Where(m => !upIds.Contains(m.Id)).Select(m => m.Id).ToList();
                }
            }

            // Library warning numbers (what ticking the box would lose).
            foreach (var m in xMods)
            {
                if (upIds.Contains(m.Id)) continue;
                if (!m.Enabled) plan.DisabledLostNames.Add(m.Name);
                if (m.Enabled && m.ModType == "gamefolder" && m.HasBackups) plan.OriginalsLost++;
            }

            // ---- 4. things in the game that stay
            if (plan.GameOk)
            {
                int enabled = xMods.Count(m => m.Enabled);
                Add(plan, Act.Keep, Kind.None, "Kept in the game", "Your installed (deployed) mods" + (xMods.Count > 0 ? " - " + enabled + " switched on" : ""),
                    plan.GamePath, null, "~mods\\Paks, SWZeroCompany\\Mods, ue4ss\\Mods and UE4SS itself stay exactly as they are");
                string modsTxt = Path.Combine(plan.GamePath, @"SWZeroCompany\Binaries\Win64\ue4ss\Mods\mods.txt");
                if (File.Exists(modsTxt))
                    Add(plan, Act.Keep, Kind.None, "Kept in the game", "UE4SS mods.txt (incl. the start-order block)", modsTxt, null,
                        "its lines keep your UE4SS mods switched on; the block marker is shared with Mod Command");
                var zcbak = new List<string>();
                CollectZcbak(Path.Combine(plan.GamePath, @"SWZeroCompany\Binaries\Win64\ue4ss"), zcbak, 0);
                CollectZcbak(Path.Combine(localAppData, @"SWZeroCompany\Saved\Config\Windows"), zcbak, 3);
                foreach (var z in zcbak)
                    Add(plan, Act.Keep, Kind.None, "Kept in the game", "Original config backup (" + Path.GetFileName(z) + ")", z, null,
                        "the only copy of the file before it was edited; the .zcbak name is shared with Mod Command");
            }
            else if (plan.GameProblem != null)
                Add(plan, Act.Warn, Kind.None, "Notes", "Game folder skipped", game, null, plan.GameProblem);
            foreach (var t in new[] { "zc-retoc" })
            {
                string p = Path.Combine(temp, t);
                if (Directory.Exists(p)) Add(plan, Act.Keep, Kind.None, "Notes", "Temporary retoc download (" + t + ")", p, null, "the name is shared with Mod Command, so it is left alone");
            }

            // ---- 5. Steam update freeze
            bool xFroze = plan.XData.Any(md => md.UpdateFreeze);
            if (xFroze && plan.GameOk)
            {
                string manifest = Steam.ManifestFor(plan.GamePath, o);
                bool upstreamFroze = upData != null && upData.UpdateFreeze && Util.Same(upData.GamePath, plan.GamePath);
                if (manifest == null)
                    Add(plan, Act.Note, Kind.None, "System settings", "Steam update freeze", null, null, "no Steam appmanifest found for the game - nothing to undo");
                else if (upstreamFroze)
                    Add(plan, Act.Keep, Kind.None, "System settings", "Steam update freeze left ON", manifest, null, "Mod Command also has the freeze switched on for this game; turn it off there");
                else
                {
                    var st = Steam.Status(manifest);
                    if (st.Frozen || st.Behavior == "1")
                        Add(plan, Act.Restore, Kind.Unfreeze, "System settings", "Undo the Steam update freeze (game updates normally again)", manifest, null,
                            "same as Settings -> freeze off: manifest writable, AutoUpdateBehavior 0");
                    else
                        Add(plan, Act.Note, Kind.None, "System settings", "Steam update freeze", manifest, null, "already off - nothing to undo");
                }
            }

            // ---- 6. nxm:// handler
            var nxm = Nxm.Inspect(o.RegClasses);
            if (nxm.Exists)
            {
                if (nxm.OwnedByX)
                    Add(plan, Act.Remove, Kind.RegKey, "System settings", "nxm:// link handler (Nexus \"Mod Manager Download\")", "HKCU\\" + o.RegClasses + "\\nxm", null,
                        "points at " + (nxm.Exe ?? "?"));
                else
                    Add(plan, Act.Keep, Kind.None, "System settings", "nxm:// link handler - belongs to " + nxm.OwnerLabel, "HKCU\\" + o.RegClasses + "\\nxm", null,
                        "points at " + (nxm.Exe ?? "(no command)") + " - not Mod Command X, left alone");
            }

            // ---- 7. program files next to this uninstaller
            if (installDir != null && Directory.Exists(installDir) && !Util.IsDriveRoot(installDir)
                && !plan.Forbidden.Any(f => Util.Same(f, installDir)))
            {
                var names = new List<string> { K.AppExeName };
                if (!sourceCheckout)
                {
                    // Release zip companions, only when they are X's own.
                    if (Util.FirstLine(Path.Combine(installDir, "README.txt")).StartsWith("MOD COMMAND X", StringComparison.OrdinalIgnoreCase)) names.Add("README.txt");
                    if (Util.FirstLine(Path.Combine(installDir, "CHANGELOG.md")).StartsWith("# Mod Command X", StringComparison.OrdinalIgnoreCase)) names.Add("CHANGELOG.md");
                }
                foreach (var n in names)
                {
                    string f = Path.Combine(installDir, n);
                    if (File.Exists(f) && !Util.Same(f, selfExe)) Add(plan, Act.Remove, Kind.File, "Program files", n, f, installDir, null);
                }
            }
            if (!o.NoSelfDelete && selfExe != null && string.Equals(Path.GetFileName(selfExe), K.UninstallerExeName, StringComparison.OrdinalIgnoreCase))
            {
                bool inInstall = installDir != null && Util.Same(selfDir, installDir);
                bool inAppCopy = Util.Same(selfDir, Path.Combine(temp, K.InAppCopyDirName));
                if (inInstall || inAppCopy)
                {
                    plan.SelfExeToDelete = selfExe;
                    if (inAppCopy || (!sourceCheckout && Path.GetFileName(selfDir).StartsWith("ModCommandX", StringComparison.OrdinalIgnoreCase)))
                        plan.SelfDirToRemove = selfDir; // only if empty afterwards
                    Add(plan, Act.Remove, Kind.None, "Program files", "This uninstaller (removed right after it closes)", selfExe, null, null).Size = SizeOf(selfExe);
                }
            }

            // ---- 8. notes
            Add(plan, Act.Note, Kind.None, "Notes", "No log files or registry settings besides nxm:// are written by Mod Command X", null, null,
                "support reports you saved yourself are your files and are not searched for");
            if (upData != null)
                Add(plan, Act.Keep, Kind.None, "Notes", "Zero Company Mod Command (the main app) is installed - nothing of it is touched", Path.Combine(appData, K.UpstreamDataDirName), null, null);
            return plan;
        }

        static void CollectZcbak(string dir, List<string> into, int depthLimit)
        {
            try
            {
                if (!Directory.Exists(dir) || Util.IsReparse(dir)) return;
                foreach (var f in Directory.EnumerateFiles(dir, "*.zcbak")) into.Add(f);
                if (depthLimit == 0) depthLimit = 6;
                if (depthLimit <= 1) return;
                foreach (var d in Directory.EnumerateDirectories(dir)) CollectZcbak(d, into, depthLimit - 1);
            }
            catch { }
        }
    }

    // ------------------------------------------------------------------ Steam (port of lib/steam.js)
    static class Steam
    {
        public class FreezeStatus { public bool Frozen; public string Behavior; }

        public static FreezeStatus Status(string manifest)
        {
            var s = new FreezeStatus();
            try
            {
                s.Frozen = (File.GetAttributes(manifest) & FileAttributes.ReadOnly) != 0;
                var m = Regex.Match(File.ReadAllText(manifest, Encoding.UTF8), "\"AutoUpdateBehavior\"\\s+\"(\\d)\"");
                s.Behavior = m.Success ? m.Groups[1].Value : null;
            }
            catch { }
            return s;
        }

        // steam.setUpdateFreeze(gamePath, false): writable manifest, AutoUpdateBehavior "0".
        public static void Unfreeze(string manifest)
        {
            var attr = File.GetAttributes(manifest);
            if ((attr & FileAttributes.ReadOnly) != 0) File.SetAttributes(manifest, attr & ~FileAttributes.ReadOnly);
            string text = File.ReadAllText(manifest, Encoding.UTF8);
            var re = new Regex("\"AutoUpdateBehavior\"\\s+\"\\d\"");
            if (re.IsMatch(text)) text = re.Replace(text, "\"AutoUpdateBehavior\"\t\t\"0\"", 1);
            else text = new Regex("(\"StateFlags\"\\s+\"\\d+\")").Replace(text, "$1\n\t\"AutoUpdateBehavior\"\t\t\"0\"", 1);
            File.WriteAllText(manifest, text, new UTF8Encoding(false));
        }

        // lib/steam.js attachManifest(): <library>\steamapps\common\<game> carries its
        // manifest next to it; otherwise scan the libraries Steam knows about.
        public static string ManifestFor(string gamePath, Options o)
        {
            try
            {
                string parentCommon = Path.GetDirectoryName(gamePath);
                string steamapps = Path.GetDirectoryName(parentCommon);
                if (string.Equals(Path.GetFileName(parentCommon), "common", StringComparison.OrdinalIgnoreCase)
                    && string.Equals(Path.GetFileName(steamapps), "steamapps", StringComparison.OrdinalIgnoreCase))
                {
                    string m = Path.Combine(steamapps, "appmanifest_" + K.AppId + ".acf");
                    if (File.Exists(m)) return m;
                }
                string root = o.SteamRoot;
                if (root == null && !o.NoSteamRegistry)
                {
                    using (var k = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam"))
                        if (k != null) root = (k.GetValue("SteamPath") as string);
                    if (root != null) root = root.Replace('/', '\\');
                }
                if (root == null || !Directory.Exists(root)) return null;
                var libs = new List<string> { Path.Combine(root, "steamapps") };
                try
                {
                    string vdf = File.ReadAllText(Path.Combine(root, "steamapps", "libraryfolders.vdf"));
                    foreach (Match mm in Regex.Matches(vdf, "\"path\"\\s+\"([^\"]+)\""))
                    {
                        string lib = Path.Combine(mm.Groups[1].Value.Replace("\\\\", "\\"), "steamapps");
                        if (Directory.Exists(lib) && !libs.Contains(lib, StringComparer.OrdinalIgnoreCase)) libs.Add(lib);
                    }
                }
                catch { }
                foreach (var lib in libs)
                {
                    string m = Path.Combine(lib, "appmanifest_" + K.AppId + ".acf");
                    if (!File.Exists(m)) continue;
                    var dir = Regex.Match(File.ReadAllText(m), "\"installdir\"\\s+\"([^\"]*)\"");
                    string cand = Path.Combine(lib, "common", dir.Success ? dir.Groups[1].Value : "Star Wars Zero Company");
                    if (Util.Same(cand, gamePath)) return m;
                }
            }
            catch { }
            return null;
        }
    }

    // ------------------------------------------------------------------ nxm:// handler
    class Nxm
    {
        public bool Exists, OwnedByX;
        public string Exe, Command, OwnerLabel;

        public static Nxm Inspect(string classesKey)
        {
            var r = new Nxm();
            try
            {
                using (var k = Registry.CurrentUser.OpenSubKey(classesKey + @"\nxm"))
                {
                    if (k == null) return r;
                    r.Exists = true;
                }
                using (var c = Registry.CurrentUser.OpenSubKey(classesKey + @"\nxm\shell\open\command"))
                    r.Command = c == null ? null : c.GetValue("") as string;
            }
            catch { return r; }
            var parts = SplitCommand(r.Command ?? "");
            r.Exe = parts.Count > 0 ? parts[0] : null;
            string file = r.Exe == null ? "" : Path.GetFileName(r.Exe);
            if (file.Equals(K.AppExeName, StringComparison.OrdinalIgnoreCase) || file.Equals(K.UnpackedExeName, StringComparison.OrdinalIgnoreCase))
                r.OwnedByX = true;
            else if (file.Equals("electron.exe", StringComparison.OrdinalIgnoreCase) && parts.Count > 1 && Util.IsXSourceCheckout(parts[1]))
                r.OwnedByX = true; // a dev run: electron.exe "<X checkout>" "%1"
            if (!r.OwnedByX)
            {
                if (file.IndexOf("ZeroCompanyModCommand", StringComparison.OrdinalIgnoreCase) >= 0
                    || file.Equals("Zero Company Mod Command.exe", StringComparison.OrdinalIgnoreCase)
                    || (file.Equals("electron.exe", StringComparison.OrdinalIgnoreCase) && (r.Command ?? "").IndexOf("ZeroCompanyModManager", StringComparison.OrdinalIgnoreCase) >= 0))
                    r.OwnerLabel = "Zero Company Mod Command";
                else r.OwnerLabel = r.Exe == null ? "an unknown program" : "another program (" + file + ")";
            }
            return r;
        }

        public static List<string> SplitCommand(string cmd)
        {
            var list = new List<string>();
            foreach (Match m in Regex.Matches(cmd, "\"([^\"]*)\"|(\\S+)"))
                list.Add(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value);
            return list;
        }

        public static void Remove(string classesKey)
        {
            Registry.CurrentUser.DeleteSubKeyTree(classesKey + @"\nxm", false);
        }
    }

    // ------------------------------------------------------------------ running app
    static class Running
    {
        public static List<Process> Find(Options o)
        {
            var found = new List<Process>();
            int self = Process.GetCurrentProcess().Id;
            string unpack = Util.Full(Path.Combine(o.Temp, K.UnpackDirName));
            foreach (var p in Process.GetProcesses())
            {
                try
                {
                    if (p.Id == self) continue;
                    if (o.ProcessNames.Any(n => string.Equals(p.ProcessName, n, StringComparison.OrdinalIgnoreCase))) { found.Add(p); continue; }
                    if (o.ProcessNamesOverridden) continue; // sandbox tests: names only
                    if (string.Equals(p.ProcessName, "electron", StringComparison.OrdinalIgnoreCase)) continue; // checked below
                    string exe = null;
                    try { exe = p.MainModule.FileName; } catch { }
                    if (exe != null && Util.IsUnder(exe, unpack)) found.Add(p);
                }
                catch { }
            }
            if (!o.ProcessNamesOverridden) found.AddRange(DevElectron());
            return found;
        }

        // `npx electron .` from an X checkout: electron.exe "<checkout>" ...
        static IEnumerable<Process> DevElectron()
        {
            var list = new List<Process>();
            try
            {
                using (var s = new System.Management.ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name = 'electron.exe'"))
                    foreach (System.Management.ManagementObject mo in s.Get())
                    {
                        var parts = Nxm.SplitCommand(Convert.ToString(mo["CommandLine"]) ?? "");
                        string dir = parts.Skip(1).FirstOrDefault(a => !a.StartsWith("-"));
                        if (dir == ".") continue;
                        if (dir != null && Util.IsXSourceCheckout(dir))
                        {
                            try { list.Add(Process.GetProcessById(Convert.ToInt32(mo["ProcessId"]))); } catch { }
                        }
                    }
            }
            catch { }
            return list;
        }

        public static string Describe(List<Process> ps)
        {
            return string.Join(", ", ps.Select(p => { try { return p.ProcessName + ".exe (PID " + p.Id + ")"; } catch { return "PID ?"; } }));
        }

        // Ask each window to close, then (force) kill what is left.
        public static bool Close(List<Process> ps, bool force, int waitMs)
        {
            foreach (var p in ps) { try { p.CloseMainWindow(); } catch { } }
            var sw = Stopwatch.StartNew();
            while (sw.ElapsedMilliseconds < waitMs && ps.Any(Alive)) Thread.Sleep(200);
            if (ps.Any(Alive) && force)
            {
                foreach (var p in ps.Where(Alive)) { try { p.Kill(); } catch { } }
                sw.Restart();
                while (sw.ElapsedMilliseconds < 5000 && ps.Any(Alive)) Thread.Sleep(200);
            }
            return !ps.Any(Alive);
        }

        static bool Alive(Process p) { try { return !p.HasExited; } catch { return false; } }
    }

    // ------------------------------------------------------------------ executor
    class Executor
    {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool MoveFileEx(string existing, string replacement, int flags);
        const int MOVEFILE_DELAY_UNTIL_REBOOT = 4;

        readonly Options o;
        readonly Plan plan;
        readonly Log log;
        public long Freed;
        public List<string> InUse = new List<string>();
        public List<string> Refused = new List<string>();
        public int Errors;

        public Executor(Options opts, Plan p, Log l) { o = opts; plan = p; log = l; }

        public void Run()
        {
            log.Line("uninstall started: " + plan.Removes.Count() + " item(s) to remove, library " + (plan.DeleteLibrary ? "DELETED" : "kept"));
            foreach (var it in plan.Items)
            {
                try
                {
                    if (it.Action == Act.Remove && (it.Kind == Kind.Dir || it.Kind == Kind.File)) RemovePath(it);
                    else if (it.Action == Act.Remove && it.Kind == Kind.RegKey)
                    {
                        // Re-check ownership right before deleting.
                        var nxm = Nxm.Inspect(o.RegClasses);
                        if (nxm.Exists && nxm.OwnedByX) { Nxm.Remove(o.RegClasses); it.Result = "removed"; log.Line("REMOVED registry " + it.Path); }
                        else { it.Result = "skipped (no longer Mod Command X's)"; log.Line("SKIPPED registry " + it.Path + " (owner changed)"); }
                    }
                    else if (it.Action == Act.Restore && it.Kind == Kind.Unfreeze)
                    {
                        Steam.Unfreeze(it.Path);
                        var st = Steam.Status(it.Path);
                        it.Result = st.Frozen || st.Behavior == "1" ? "failed: manifest still frozen" : "restored";
                        log.Line("UNFREEZE " + it.Path + " -> " + it.Result);
                        if (it.Result != "restored") Errors++;
                    }
                    else if (it.Action == Act.Keep && it.Kind == Kind.ScrubSettings) ScrubSecrets(it);
                    else if (it.Action == Act.Remove && it.Kind == Kind.MirrorScrub) ScrubMirror(it);
                    else if (it.Action == Act.Keep) log.Line("KEPT " + (it.Path ?? it.Label));
                }
                catch (Exception e)
                {
                    it.Result = "failed: " + e.Message;
                    Errors++;
                    log.Line("FAILED " + (it.Path ?? it.Label) + ": " + e.Message);
                }
            }
            log.Line("uninstall finished: " + Util.HumanSize(Freed) + " freed, " + InUse.Count + " in use, " + Refused.Count + " refused, " + Errors + " error(s)");
        }

        // The allow-list check every delete passes: inside its X-owned root, never
        // a drive root / forbidden folder / ancestor of one, no junction on the way.
        public static string Refusal(string path, string allowRoot, Plan plan)
        {
            string full = Util.Full(path), root = Util.Full(allowRoot);
            if (full == null || root == null) return "unresolvable path";
            if (Util.IsDriveRoot(full)) return "drive root";
            if (!(Util.Same(full, root) || Util.IsUnder(full, root))) return "outside its Mod Command X root";
            foreach (var f in plan.Forbidden)
            {
                if (f == null) continue;
                if (Util.Same(full, f)) return "protected folder";
                if (Util.IsUnder(f, full)) return "contains a protected folder";
            }
            // No reparse point between the root and the target (the target itself
            // may be one: then only the link is removed).
            string cur = full;
            while (!Util.Same(cur, root))
            {
                string parent = Path.GetDirectoryName(cur);
                if (parent == null) return "outside its Mod Command X root";
                if (!Util.Same(parent, root) && Util.IsReparse(parent)) return "path runs through a link";
                cur = parent;
            }
            if (!Util.Same(full, root) && Util.IsReparse(root)) return "root is a link";
            return null;
        }

        void RemovePath(PlanItem it)
        {
            string why = Refusal(it.Path, it.AllowRoot, plan);
            if (why != null)
            {
                it.Result = "refused: " + why;
                Refused.Add(it.Path);
                log.Line("REFUSED " + it.Path + " (" + why + ")");
                return;
            }
            if (!Util.Exists(it.Path)) { it.Result = "already gone"; return; }
            int before = InUse.Count;
            long freed = DeleteTree(it.Path);
            Freed += freed;
            it.Result = InUse.Count > before ? "partly removed - " + (InUse.Count - before) + " file(s) in use" : "removed";
            log.Line((InUse.Count > before ? "PARTLY REMOVED " : "REMOVED ") + it.Path + " (" + Util.HumanSize(freed) + ")");
        }

        long DeleteTree(string p)
        {
            FileAttributes a;
            try { a = File.GetAttributes(p); } catch { return 0; }
            if ((a & FileAttributes.ReparsePoint) != 0)
            {
                // A junction / symlink: remove the link itself, never its target.
                try { if ((a & FileAttributes.Directory) != 0) Directory.Delete(p, false); else File.Delete(p); }
                catch (Exception e) { InUse.Add(p); log.Line("IN USE " + p + " (" + e.Message + ")"); }
                return 0;
            }
            if ((a & FileAttributes.Directory) == 0) return DeleteFile(p);
            long n = 0;
            List<string> entries;
            try { entries = Directory.EnumerateFileSystemEntries(p).ToList(); } catch { entries = new List<string>(); }
            foreach (var e in entries) n += DeleteTree(e);
            for (int i = 0; i < 5; i++)
            {
                try { if ((a & FileAttributes.ReadOnly) != 0) File.SetAttributes(p, FileAttributes.Directory); Directory.Delete(p, false); break; }
                catch (DirectoryNotFoundException) { break; }
                catch (IOException) { if (!Directory.EnumerateFileSystemEntries(p).Any()) Thread.Sleep(150); else break; }
                catch (UnauthorizedAccessException) { Thread.Sleep(150); }
            }
            return n;
        }

        long DeleteFile(string p)
        {
            long size = 0;
            try { size = new FileInfo(p).Length; } catch { }
            Exception last = null;
            for (int i = 0; i < 6; i++)
            {
                try
                {
                    var a = File.GetAttributes(p);
                    if ((a & FileAttributes.ReadOnly) != 0) File.SetAttributes(p, a & ~FileAttributes.ReadOnly);
                    File.Delete(p);
                    return size;
                }
                catch (FileNotFoundException) { return 0; }
                catch (DirectoryNotFoundException) { return 0; }
                catch (Exception e) { last = e; Thread.Sleep(200); }
            }
            bool scheduled = MoveFileEx(p, null, MOVEFILE_DELAY_UNTIL_REBOOT); // needs admin; usually refused
            InUse.Add(p + (scheduled ? " (removed at next restart)" : ""));
            log.Line("IN USE " + p + (scheduled ? " - scheduled for removal at next restart" : " - left in place") + " (" + (last == null ? "" : last.Message) + ")");
            return 0;
        }

        // Shared mirror: take out only what is X's (lib/storage.js mergeMirror
        // wrote it): the modCommandX block, X's profiles, the records of X-only
        // mods, and X's settings block when X created the mirror. Everything else
        // is written back exactly as JSON.stringify(v, null, 2) wrote it.
        void ScrubMirror(PlanItem it)
        {
            string why = Refusal(it.Path, it.AllowRoot, plan);
            if (why != null) { it.Result = "refused: " + why; Refused.Add(it.Path); log.Line("REFUSED " + it.Path + " (" + why + ")"); return; }
            var raw = J.ReadFile(it.Path);
            if (raw == null) { it.Result = "skipped (unreadable)"; log.Line("SKIPPED " + it.Path + " (unreadable)"); return; }
            var block = J.Obj(raw, K.XBlock);
            if (block == null) { it.Result = "nothing of Mod Command X's left in it"; return; }
            var drop = new HashSet<string>(it.RemoveIds ?? new List<string>());
            var xProfiles = new HashSet<string>(J.Arr(block, "profileIds").Select(x => Convert.ToString(x)));
            int removedMods = 0, removedProfiles = 0;
            var mods = raw.ContainsKey("mods") ? raw["mods"] as object[] : null;
            if (mods != null)
            {
                var keep = mods.Where(m => !drop.Contains(J.Str(m as Dictionary<string, object>, "id") ?? "\u0000")).ToArray();
                removedMods = mods.Length - keep.Length;
                raw["mods"] = keep;
            }
            var profiles = raw.ContainsKey("profiles") ? raw["profiles"] as object[] : null;
            if (profiles != null)
            {
                var keep = profiles.Where(p =>
                {
                    var pd = p as Dictionary<string, object>;
                    return pd == null || !pd.ContainsKey("id") || !xProfiles.Contains(Convert.ToString(pd["id"]));
                }).ToArray();
                removedProfiles = profiles.Length - keep.Length;
                raw["profiles"] = keep;
            }
            if (J.Bool(block, "ownsSettings"))
            {
                if (raw.ContainsKey("settings")) raw["settings"] = new Dictionary<string, object>();
                if (raw.ContainsKey("lastOrderBackup")) raw["lastOrderBackup"] = null;
            }
            raw.Remove(K.XBlock);
            string tmp = it.Path + ".mcx-uninstall.tmp";
            File.WriteAllText(tmp, JsonText.Stringify(raw), new UTF8Encoding(false));
            File.Copy(tmp, it.Path, true);
            File.Delete(tmp);
            it.Result = "Mod Command X's part removed (" + removedMods + " record(s), " + removedProfiles + " profile(s))";
            log.Line("MIRROR " + it.Path + ": X block, " + removedMods + " X-only record(s), " + removedProfiles + " profile(s) removed");
        }

        // Keep a stored-library manifest but strip every credential from it.
        void ScrubSecrets(PlanItem it)
        {
            var raw = J.ReadFile(it.Path);
            var st = J.Obj(raw, "settings");
            if (st == null) { it.Result = "kept"; return; }
            bool changed = false;
            foreach (var k in K.SecretKeys) if (st.Remove(k)) changed = true;
            if (changed) File.WriteAllText(it.Path, J.Serialize(raw), new UTF8Encoding(false));
            it.Result = changed ? "kept (sign-in data removed)" : "kept";
            log.Line("KEPT " + it.Path + (changed ? " (credentials stripped)" : ""));
        }
    }

    // ------------------------------------------------------------------ log (redacted)
    class Log
    {
        readonly string file;
        readonly string profile;
        public Log(string path, string userProfile) { file = path; profile = Util.Full(userProfile); }

        public string Redact(string s)
        {
            if (s == null) return s;
            if (!string.IsNullOrEmpty(profile)) s = Regex.Replace(s, Regex.Escape(profile), "%USERPROFILE%", RegexOptions.IgnoreCase);
            // Never let anything that looks like a key or token through.
            s = Regex.Replace(s, "(?i)(apikey|api_key|token|key)=([^&\\s]+)", "$1=<redacted>");
            return s;
        }

        public void Line(string s)
        {
            try { File.AppendAllText(file, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + Redact(s) + Environment.NewLine, new UTF8Encoding(false)); }
            catch { }
        }
    }

    // ------------------------------------------------------------------ self-delete
    static class SelfDelete
    {
        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        static extern bool MoveFileEx(string existing, string replacement, int flags);

        public static void Schedule(Plan plan, Log log)
        {
            if (plan.SelfExeToDelete == null) return;
            string exe = plan.SelfExeToDelete;
            string cmd = "/d /c ping 127.0.0.1 -n 3 >nul & del /f /q \"" + exe + "\"";
            if (plan.SelfDirToRemove != null) cmd += " & rmdir \"" + plan.SelfDirToRemove + "\"";
            try
            {
                var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "cmd.exe"), cmd)
                {
                    CreateNoWindow = true, UseShellExecute = false, WindowStyle = ProcessWindowStyle.Hidden,
                    WorkingDirectory = Environment.SystemDirectory,
                };
                Process.Start(psi);
                log.Line("self-delete scheduled for " + exe);
            }
            catch (Exception e)
            {
                bool ok = MoveFileEx(exe, null, 4);
                log.Line("self-delete via cmd failed (" + e.Message + "); " + (ok ? "scheduled for next restart" : "left in place"));
            }
        }
    }

    // ------------------------------------------------------------------ report / text
    static class Report
    {
        public static object PlanObject(Plan plan, Executor ex)
        {
            var items = plan.Items.Select(i => new Dictionary<string, object> {
                { "action", i.Action.ToString().ToLowerInvariant() }, { "kind", i.Kind.ToString().ToLowerInvariant() },
                { "group", i.Group }, { "label", i.Label }, { "path", i.Path }, { "size", i.Size }, { "note", i.Note },
                { "library", i.Library }, { "result", i.Result },
            }).ToList();
            var d = new Dictionary<string, object> {
                { "deleteLibrary", plan.DeleteLibrary }, { "gamePath", plan.GamePath }, { "gameOk", plan.GameOk },
                { "gameProblem", plan.GameProblem }, { "removeBytes", plan.RemoveBytes },
                { "disabledLost", plan.DisabledLostNames }, { "originalsLost", plan.OriginalsLost },
                { "sharedArchive", plan.SharedArchive }, { "sharedKept", plan.SharedKept },
                { "libraryLocations", plan.LibraryLocations }, { "selfDelete", plan.SelfExeToDelete },
                { "items", items },
            };
            if (ex != null)
            {
                d["freed"] = ex.Freed; d["inUse"] = ex.InUse; d["refused"] = ex.Refused; d["errors"] = ex.Errors;
            }
            return d;
        }

        public static string Text(Plan plan)
        {
            var sb = new StringBuilder();
            foreach (var grp in new[] { Act.Remove, Act.Restore, Act.Keep, Act.Warn, Act.Note })
            {
                var items = plan.Items.Where(i => i.Action == grp).ToList();
                if (items.Count == 0) continue;
                string head = grp == Act.Remove ? "WILL BE REMOVED (" + Util.HumanSize(plan.RemoveBytes) + ")"
                    : grp == Act.Restore ? "WILL BE RESTORED" : grp == Act.Keep ? "WILL BE KEPT" : grp == Act.Warn ? "WARNINGS" : "NOTES";
                sb.AppendLine(head);
                foreach (var i in items)
                    sb.AppendLine("  - " + i.Label + (i.Size >= 0 ? "  [" + Util.HumanSize(i.Size) + "]" : "") + (i.Path != null ? "\r\n      " + i.Path : "")
                        + (i.Note != null ? "\r\n      (" + i.Note + ")" : "") + (i.Result != null ? "\r\n      => " + i.Result : ""));
                sb.AppendLine();
            }
            return sb.ToString();
        }

        public static string LibraryWarning(Plan planIfDeleted, Plan planIfKept)
        {
            var sb = new StringBuilder();
            var p = planIfDeleted;
            if (p.DisabledLostNames.Count > 0)
                sb.Append(p.DisabledLostNames.Count + " switched-off mod(s) exist ONLY in the library and will be lost: "
                    + string.Join(", ", p.DisabledLostNames.Take(6)) + (p.DisabledLostNames.Count > 6 ? ", ..." : "") + ". ");
            else sb.Append("No switched-off mods would be lost. ");
            if (p.OriginalsLost > 0)
                sb.Append(p.OriginalsLost + " switched-on mod(s) replace game files whose originals are backed up there - after deleting, use Steam's \"Verify integrity\" to get them back. ");
            if (p.SharedArchive)
                sb.Append("The archive is shared with Mod Command: entries it also uses (" + p.SharedKept + ") are kept either way. ");
            sb.Append("Installed mods in the game stay.");
            return sb.ToString();
        }

        public static string LibraryKeepNote(Plan p)
        {
            if (p.LibraryLocations.Count == 0) return "There is no stored mod library to keep.";
            return "Kept - your mod library stays in:\n  " + string.Join("\n  ", p.LibraryLocations.Distinct(StringComparer.OrdinalIgnoreCase))
                + "\nReinstalling Mod Command X restores everything from there."
                + (p.SharedArchive ? " (The archive is shared with Mod Command.)" : "");
        }
    }

    // ------------------------------------------------------------------ program
    static class Program
    {
        [DllImport("kernel32.dll")] static extern bool AttachConsole(int pid);

        [STAThread]
        static int Main(string[] args)
        {
            Options o;
            try { o = Options.Parse(args); }
            catch (Exception e) { Out(null, "error: " + e.Message); return 64; }
            if (o.WaitPid > 0)
            {
                // Started from the app's Settings: let it quit, and give the
                // portable launcher a moment to clean up after it.
                try { var p = Process.GetProcessById(o.WaitPid); p.WaitForExit(30000); } catch { }
                var sw = Stopwatch.StartNew();
                while (sw.ElapsedMilliseconds < 15000 && Running.Find(o).Count > 0) Thread.Sleep(300);
            }
            if (o.Headless) return Cli(o);
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            var f = new MainForm(o);
            Application.Run(f);
            if (f.Done && !o.NoSelfDelete) SelfDelete.Schedule(f.FinalPlan, f.TheLog);
            return f.ExitCode;
        }

        static bool consoleTried;
        public static void Out(Options o, string s)
        {
            if (!consoleTried) { consoleTried = true; try { AttachConsole(-1); } catch { } }
            try { Console.WriteLine(s); } catch { }
        }

        static int Cli(Options o)
        {
            var log = new Log(o.LogPath, o.UserProfile);
            var plan = new Planner(o).Build(o.DeleteLibrary);
            if (o.DryRun)
            {
                if (o.ReportPath != null) File.WriteAllText(o.ReportPath, J.Serialize(Report.PlanObject(plan, null)), new UTF8Encoding(false));
                Out(o, o.Json ? J.Serialize(Report.PlanObject(plan, null)) : "DRY RUN - nothing is changed.\r\n\r\n" + Report.Text(plan));
                return 0;
            }
            var running = Running.Find(o);
            if (running.Count > 0)
            {
                if (!o.CloseRunning)
                {
                    string msg = "refused: Mod Command X is running (" + Running.Describe(running) + "). Close it first, or pass --close-running.";
                    log.Line(msg);
                    if (o.ReportPath != null) File.WriteAllText(o.ReportPath, J.Serialize(new Dictionary<string, object> { { "refused", "running" }, { "processes", Running.Describe(running) } }));
                    Out(o, msg);
                    return 2;
                }
                if (!Running.Close(running, true, 8000)) { Out(o, "refused: could not close Mod Command X"); return 2; }
                plan = new Planner(o).Build(o.DeleteLibrary);
            }
            var ex = new Executor(o, plan, log);
            ex.Run();
            if (o.ReportPath != null) File.WriteAllText(o.ReportPath, J.Serialize(Report.PlanObject(plan, ex)), new UTF8Encoding(false));
            Out(o, o.Json ? J.Serialize(Report.PlanObject(plan, ex)) : Report.Text(plan));
            if (!o.NoSelfDelete) SelfDelete.Schedule(plan, log);
            return ex.Errors > 0 || ex.Refused.Count > 0 ? 3 : (ex.InUse.Count > 0 ? 4 : 0);
        }
    }

    // ------------------------------------------------------------------ UI
    class MainForm : Form
    {
        static readonly Color Bg = ColorTranslator.FromHtml("#15171a");
        static readonly Color Raise = ColorTranslator.FromHtml("#1d2022");
        static readonly Color Text_ = ColorTranslator.FromHtml("#ebe3cf");
        static readonly Color Dim = ColorTranslator.FromHtml("#b9ad8f");
        static readonly Color Holo = ColorTranslator.FromHtml("#a9bb86");
        static readonly Color Amber = ColorTranslator.FromHtml("#c3953a");
        static readonly Color Danger = ColorTranslator.FromHtml("#e5704f");
        static readonly Color Rust = ColorTranslator.FromHtml("#8e2b20");

        readonly Options o;
        public Log TheLog;
        public Plan FinalPlan;
        public bool Done;
        public int ExitCode = 1;
        Plan keepPlan, deletePlan;
        ListView lv;
        CheckBox chk;
        Label lblLib, lblBanner, lblSub;
        Button btnGo, btnCancel;

        public MainForm(Options opts)
        {
            o = opts;
            TheLog = new Log(o.LogPath, o.UserProfile);
            Text = "Uninstall Mod Command X";
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            BackColor = Bg; ForeColor = Text_;
            Font = new Font("Segoe UI", 9f);
            ClientSize = new Size(900, 660);
            MinimumSize = new Size(720, 520);
            StartPosition = FormStartPosition.CenterScreen;

            var title = new Label { Text = "UNINSTALL MOD COMMAND X", Font = new Font("Segoe UI Semibold", 15f), ForeColor = Holo, AutoSize = true, Location = new Point(18, 14) };
            lblSub = new Label { Text = "Removes everything Mod Command X created. Your installed mods stay in the game and keep working.", ForeColor = Dim, AutoSize = false, Location = new Point(20, 50), Size = new Size(860, 20), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right };
            lblBanner = new Label { ForeColor = Amber, AutoSize = false, Location = new Point(20, 72), Size = new Size(860, 20), Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right, Visible = false };

            lv = new ListView
            {
                View = View.Details, FullRowSelect = true, HeaderStyle = ColumnHeaderStyle.Nonclickable,
                BackColor = Raise, ForeColor = Text_, BorderStyle = BorderStyle.FixedSingle,
                Location = new Point(20, 96), Size = new Size(860, 356), ShowItemToolTips = true,
                Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right,
                OwnerDraw = true,
            };
            lv.Columns.Add("What", 330); lv.Columns.Add("Where", 430); lv.Columns.Add("Size", 80, HorizontalAlignment.Right);
            lv.DrawColumnHeader += (s, e) =>
            {
                using (var b = new SolidBrush(Bg)) e.Graphics.FillRectangle(b, e.Bounds);
                var r = e.Bounds; r.Inflate(-6, 0);
                TextRenderer.DrawText(e.Graphics, e.Header.Text.ToUpperInvariant(), lv.Font, r, Dim,
                    TextFormatFlags.VerticalCenter | (e.Header.TextAlign == HorizontalAlignment.Right ? TextFormatFlags.Right : TextFormatFlags.Left));
            };
            lv.DrawItem += (s, e) => { e.DrawDefault = false; };
            lv.DrawSubItem += (s, e) =>
            {
                // Paths keep their tail visible ("C:\...\ModCommandXArchive").
                using (var b = new SolidBrush(e.Item.Selected ? Color.FromArgb(70, Holo) : Raise)) e.Graphics.FillRectangle(b, e.Bounds);
                var r = e.Bounds; r.Inflate(-5, 0);
                var flags = TextFormatFlags.VerticalCenter | TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine
                    | (e.ColumnIndex == 1 ? TextFormatFlags.PathEllipsis : TextFormatFlags.EndEllipsis)
                    | (e.ColumnIndex == 2 ? TextFormatFlags.Right : TextFormatFlags.Left);
                TextRenderer.DrawText(e.Graphics, e.SubItem.Text, lv.Font, r, e.ColumnIndex == 1 && e.Item.ForeColor == Text_ ? Dim : e.Item.ForeColor, flags);
            };

            chk = new CheckBox
            {
                Text = "Also delete my stored mod library (mods you switched off live only here and would be lost)",
                Checked = false, AutoSize = true, ForeColor = Text_, Location = new Point(20, 464),
                Anchor = AnchorStyles.Bottom | AnchorStyles.Left,
            };
            chk.CheckedChanged += (s, e) => Render();
            lblLib = new Label { AutoSize = false, Location = new Point(38, 488), Size = new Size(842, 112), ForeColor = Dim, Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right };

            btnGo = new Button { Text = "Uninstall", Size = new Size(140, 34), Location = new Point(590, 610), Anchor = AnchorStyles.Bottom | AnchorStyles.Right, FlatStyle = FlatStyle.Flat, BackColor = Rust, ForeColor = Text_ };
            btnGo.FlatAppearance.BorderColor = Danger;
            btnCancel = new Button { Text = "Cancel", Size = new Size(140, 34), Location = new Point(740, 610), Anchor = AnchorStyles.Bottom | AnchorStyles.Right, FlatStyle = FlatStyle.Flat, BackColor = Raise, ForeColor = Text_ };
            btnCancel.FlatAppearance.BorderColor = Holo;
            btnGo.Click += (s, e) => DoUninstall();
            btnCancel.Click += (s, e) => Close();
            AcceptButton = null; CancelButton = btnCancel;

            Controls.AddRange(new Control[] { title, lblSub, lblBanner, lv, chk, lblLib, btnGo, btnCancel });

            Cursor = Cursors.WaitCursor;
            var planner = new Planner(o);
            keepPlan = planner.Build(false);
            deletePlan = planner.Build(true);
            Cursor = Cursors.Default;
            chk.Enabled = keepPlan.LibraryLocations.Count > 0;
            UpdateBanner();
            Render();

            if (o.Screenshot != null)
            {
                StartPosition = FormStartPosition.Manual;
                Location = new Point(-5000, -5000);
                ShowInTaskbar = false;
                if (o.DeleteLibrary) chk.Checked = true;
                var t = new System.Windows.Forms.Timer { Interval = 900 };
                t.Tick += (s, e) => { t.Stop(); Shot.Save(this, o.Screenshot); ExitCode = 0; Close(); };
                Shown += (s, e) => t.Start();
            }
        }

        Plan Current { get { return chk.Checked ? deletePlan : keepPlan; } }

        void UpdateBanner()
        {
            var running = Running.Find(o);
            lblBanner.Visible = running.Count > 0;
            if (running.Count > 0) lblBanner.Text = "Mod Command X is running (" + Running.Describe(running) + ") - it will be closed before anything is removed.";
        }

        void Render()
        {
            var p = Current;
            lblLib.ForeColor = chk.Checked ? Danger : Dim;
            lblLib.Text = chk.Checked ? "WARNING: " + Report.LibraryWarning(deletePlan, keepPlan) : Report.LibraryKeepNote(keepPlan);
            Fill(p, false);
        }

        void Fill(Plan p, bool after)
        {
            lv.BeginUpdate();
            lv.Items.Clear(); lv.Groups.Clear();
            var groups = new List<Tuple<Act, string>> {
                Tuple.Create(Act.Remove, after ? "REMOVED" : "WILL BE REMOVED  -  " + Util.HumanSize(p.RemoveBytes)),
                Tuple.Create(Act.Restore, after ? "RESTORED" : "WILL BE UNDONE"),
                Tuple.Create(Act.Keep, after ? "KEPT" : "WILL BE KEPT"),
                Tuple.Create(Act.Warn, "WARNINGS"),
                Tuple.Create(Act.Note, "NOTES"),
            };
            foreach (var g in groups)
            {
                var items = p.Items.Where(i => i.Action == g.Item1).ToList();
                if (items.Count == 0) continue;
                var lg = new ListViewGroup(g.Item2);
                lv.Groups.Add(lg);
                foreach (var i in items)
                {
                    string label = i.Label;
                    if (after && i.Result != null && i.Result != "removed" && i.Result != "restored" && i.Result != "kept") label += "  -  " + i.Result;
                    var li = new ListViewItem(new[] { label, i.Path ?? "", i.Size >= 0 ? Util.HumanSize(i.Size) : "" }, lg);
                    li.ToolTipText = (i.Path ?? "") + (i.Note != null ? "\n" + i.Note : "") + (i.Result != null ? "\n=> " + i.Result : "");
                    li.ForeColor = g.Item1 == Act.Remove ? Text_ : g.Item1 == Act.Keep ? Holo : g.Item1 == Act.Restore ? Amber : g.Item1 == Act.Warn ? Danger : Dim;
                    if (after && i.Result != null && (i.Result.StartsWith("failed") || i.Result.StartsWith("refused") || i.Result.StartsWith("partly"))) li.ForeColor = Danger;
                    lv.Items.Add(li);
                }
            }
            lv.EndUpdate();
        }

        void DoUninstall()
        {
            if (Done) { Close(); return; }
            var running = Running.Find(o);
            if (running.Count > 0)
            {
                var r = MessageBox.Show(this, "Mod Command X is still running (" + Running.Describe(running) + ").\n\nClose it now? Anything it is doing (a download, an install) is stopped.",
                    "Mod Command X is running", MessageBoxButtons.YesNo, MessageBoxIcon.Warning);
                if (r != DialogResult.Yes) return;
                Cursor = Cursors.WaitCursor;
                bool closed = Running.Close(running, false, 10000);
                Cursor = Cursors.Default;
                if (!closed)
                {
                    if (MessageBox.Show(this, "Mod Command X did not close. Force it to close?", "Mod Command X is running", MessageBoxButtons.YesNo, MessageBoxIcon.Warning) != DialogResult.Yes) return;
                    if (!Running.Close(running, true, 3000)) { MessageBox.Show(this, "Mod Command X could not be closed. Close it yourself and try again.", "Uninstall", MessageBoxButtons.OK, MessageBoxIcon.Error); return; }
                }
                UpdateBanner();
                var planner = new Planner(o);
                keepPlan = planner.Build(false); deletePlan = planner.Build(true);
                Render();
            }
            var p = Current;
            string msg = "Remove Mod Command X now?\n\n" + p.Removes.Count() + " item(s), " + Util.HumanSize(p.RemoveBytes) + ", are removed. This cannot be undone.\n\n"
                + (chk.Checked ? "Your stored mod library is DELETED. " + (p.DisabledLostNames.Count > 0 ? p.DisabledLostNames.Count + " switched-off mod(s) are lost." : "") : "Your stored mod library is kept.")
                + "\nInstalled mods in the game are not touched.";
            if (MessageBox.Show(this, msg, "Confirm uninstall", MessageBoxButtons.OKCancel, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2) != DialogResult.OK) return;

            Cursor = Cursors.WaitCursor;
            btnGo.Enabled = false; btnCancel.Enabled = false; chk.Enabled = false;
            var ex = new Executor(o, p, TheLog);
            ex.Run();
            Cursor = Cursors.Default;
            FinalPlan = p; Done = true;
            ExitCode = ex.Errors > 0 || ex.Refused.Count > 0 ? 3 : (ex.InUse.Count > 0 ? 4 : 0);
            Fill(p, true);
            lblSub.Text = "Done. " + Util.HumanSize(ex.Freed) + " removed." + (ex.InUse.Count > 0 ? " " + ex.InUse.Count + " file(s) were in use and were left in place - listed above." : "")
                + (ex.Errors + ex.Refused.Count > 0 ? " Some items could not be removed - see above." : "") + " Log: " + o.LogPath;
            lblSub.ForeColor = ex.Errors + ex.Refused.Count + ex.InUse.Count > 0 ? Amber : Holo;
            lblLib.ForeColor = Dim;
            lblLib.Text = chk.Checked ? "Your stored mod library was deleted. Installed mods in the game were not touched."
                : Report.LibraryKeepNote(p) + " Installed mods in the game were not touched.";
            btnGo.Text = "Close"; btnGo.BackColor = Raise; btnGo.FlatAppearance.BorderColor = Holo;
            btnGo.Enabled = true; btnCancel.Visible = false;
        }
    }

    static class Shot
    {
        [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

        public static void Save(Form f, string file)
        {
            using (var bmp = new Bitmap(f.Width, f.Height))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    IntPtr hdc = g.GetHdc();
                    bool ok = PrintWindow(f.Handle, hdc, 2);
                    g.ReleaseHdc(hdc);
                    if (!ok) f.DrawToBitmap(bmp, new Rectangle(0, 0, f.Width, f.Height));
                }
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(file)));
                bmp.Save(file, System.Drawing.Imaging.ImageFormat.Png);
            }
        }
    }
}
