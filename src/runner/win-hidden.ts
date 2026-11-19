import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crossSpawn from 'cross-spawn';

/**
 * Windows only (D63, card #99). Starts a run's process with a console that has no window, outside the job
 * object Node puts its children in, with stdin/stdout/stderr on files.
 *
 * Why not `spawn(..., { detached: true })`: on Windows libuv turns that into DETACHED_PROCESS, so
 * the process has no console at all. Every console program it starts afterwards (bash, git, the
 * node of a hook or of an MCP server) that does not ask for CREATE_NO_WINDOW itself then gets a
 * console of its own, and that console comes with a visible window. Claude Code starts many of
 * those per run, which is the row of terminal windows of card #99.
 *
 * Here a short-lived PowerShell calls CreateProcess with CREATE_NO_WINDOW: the process gets a
 * console with no window, and everything it starts inherits that console instead of opening one.
 * CREATE_BREAKAWAY_FROM_JOB (and the job's silent breakaway, since PowerShell is the one creating
 * it) keeps the D45 guarantee that the run outlives the Board. Only the three file handles are
 * inherited (PROC_THREAD_ATTRIBUTE_HANDLE_LIST), so the PowerShell pipes the Board reads never
 * reach the run.
 */

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ClaudeBoardHiddenLaunch {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll")]
  static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static IntPtr Open(string file, bool write) {
    SECURITY_ATTRIBUTES sa = new SECURITY_ATTRIBUTES();
    sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
    sa.bInheritHandle = 1;
    // Read: GENERIC_READ, OPEN_EXISTING. Write: FILE_APPEND_DATA | FILE_READ_ATTRIBUTES | SYNCHRONIZE, OPEN_ALWAYS,
    // so every write lands at the end, as with Node's 'a' flag.
    uint access = write ? 0x00100084u : 0x80000000u;
    IntPtr h = CreateFileW(file, access, 7, ref sa, write ? 4u : 3u, 0x80, IntPtr.Zero);
    if (h == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "open " + file);
    return h;
  }

  public static int Start(string application, string commandLine, string cwd, string[] environment, string stdin, string stdout, string stderr) {
    IntPtr hIn = Open(stdin, false), hOut = Open(stdout, true), hErr = Open(stderr, true);
    IntPtr env = IntPtr.Zero, list = IntPtr.Zero, handles = IntPtr.Zero;
    try {
      StringBuilder block = new StringBuilder();
      foreach (string pair in environment) { block.Append(pair); block.Append('\0'); }
      block.Append('\0');
      env = Marshal.StringToHGlobalUni(block.ToString());

      handles = Marshal.AllocHGlobal(IntPtr.Size * 3);
      Marshal.WriteIntPtr(handles, 0, hIn);
      Marshal.WriteIntPtr(handles, IntPtr.Size, hOut);
      Marshal.WriteIntPtr(handles, IntPtr.Size * 2, hErr);
      IntPtr size = IntPtr.Zero;
      InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
      list = Marshal.AllocHGlobal(size);
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error(), "attribute list");
      // PROC_THREAD_ATTRIBUTE_HANDLE_LIST
      if (!UpdateProcThreadAttribute(list, 0, new IntPtr(0x20002), handles, new IntPtr(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "handle list");

      STARTUPINFOEX si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.StartupInfo.dwFlags = 0x101; // STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW
      si.StartupInfo.wShowWindow = 0; // SW_HIDE
      si.StartupInfo.hStdInput = hIn;
      si.StartupInfo.hStdOutput = hOut;
      si.StartupInfo.hStdError = hErr;
      si.lpAttributeList = list;

      // EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
      uint flags = 0x00080000u | 0x00000400u | 0x00000200u | 0x08000000u;
      PROCESS_INFORMATION pi;
      // First with CREATE_BREAKAWAY_FROM_JOB; a job that forbids breakaway refuses it (access denied),
      // and then the job's silent breakaway, if any, is what is left.
      bool ok = CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags | 0x01000000u, env, cwd, ref si, out pi);
      if (!ok && Marshal.GetLastWin32Error() == 5)
        ok = CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, flags, env, cwd, ref si, out pi);
      if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess " + application);
      CloseHandle(pi.hThread);
      CloseHandle(pi.hProcess);
      return pi.dwProcessId;
    } finally {
      if (list != IntPtr.Zero) { DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
      if (handles != IntPtr.Zero) Marshal.FreeHGlobal(handles);
      if (env != IntPtr.Zero) Marshal.FreeHGlobal(env);
      CloseHandle(hIn); CloseHandle(hOut); CloseHandle(hErr);
    }
  }
}
`;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
$p = Get-Content -LiteralPath $env:CLAUDE_BOARD_LAUNCH -Raw -Encoding UTF8 | ConvertFrom-Json
Add-Type -TypeDefinition $p.source
[ClaudeBoardHiddenLaunch]::Start($p.application, $p.commandLine, $p.cwd, [string[]]$p.environment, $p.stdin, $p.stdout, $p.stderr)
`;

/** Quotes one argument the way CommandLineToArgvW reads it back (same rules as libuv). */
export function quoteWindowsArg(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"]/.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === '\\') {
      backslashes++;
      continue;
    }
    if (ch === '"') out += '\\'.repeat(backslashes * 2 + 1) + '"';
    else out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  return out + '\\'.repeat(backslashes * 2) + '"';
}

/** The application and command line CreateProcess gets, resolved like cross-spawn (PATHEXT, .cmd shims). */
export function windowsCommandLine(command: string, args: string[], env: NodeJS.ProcessEnv): { application: string; commandLine: string } {
  const parse = (crossSpawn as unknown as { _parse: (c: string, a: string[], o: object) => unknown })._parse;
  const parsed = parse(command, args, { env }) as {
    command: string;
    args: string[];
    file?: string;
    options: { windowsVerbatimArguments?: boolean };
  };
  // A .cmd shim comes back as cmd.exe with arguments cross-spawn already escaped for it.
  const verbatim = Boolean(parsed.options.windowsVerbatimArguments);
  const head = quoteWindowsArg(parsed.command);
  const rest = parsed.args.map((a) => (verbatim ? a : quoteWindowsArg(a)));
  const application = parsed.file && path.isAbsolute(parsed.file) && !verbatim ? parsed.file : resolveOnPath(parsed.command, env);
  return { application, commandLine: [head, ...rest].join(' ') };
}

function resolveOnPath(command: string, env: NodeJS.ProcessEnv): string {
  if (path.isAbsolute(command)) return command;
  const dirs = (env.PATH ?? env.Path ?? '').split(';').filter(Boolean);
  const exts = (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';');
  for (const dir of dirs) {
    for (const ext of ['', ...exts]) {
      const file = path.join(dir, command + ext);
      if (ext && fs.existsSync(file)) return file;
    }
  }
  if (/^cmd(\.exe)?$/i.test(command)) return path.join(env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'cmd.exe');
  return command;
}

export interface HiddenLaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdinFile: string;
  stdoutFile: string;
  stderrFile: string;
  /** Where the launch request is written (next to the run's files). */
  launchFile: string;
}

/** Starts the process and returns its pid. Throws with PowerShell's message when it cannot. */
export function startHidden(command: string, args: string[], opts: HiddenLaunchOptions): number {
  const { application, commandLine } = windowsCommandLine(command, args, opts.env);
  const environment = Object.entries(opts.env)
    .filter(([k, v]) => v !== undefined && k !== '' && !k.startsWith('='))
    .map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(
    opts.launchFile,
    JSON.stringify({ source: CSHARP, application, commandLine, cwd: opts.cwd, environment, stdin: opts.stdinFile, stdout: opts.stdoutFile, stderr: opts.stderrFile }),
  );
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { env: { ...process.env, CLAUDE_BOARD_LAUNCH: opts.launchFile }, encoding: 'utf8', windowsHide: true, timeout: 60000 },
  );
  const pid = Number((r.stdout ?? '').trim().split(/\r?\n/).pop());
  if (r.status === 0 && Number.isInteger(pid) && pid > 0) return pid;
  const why = (r.stderr || r.error?.message || r.stdout || `saída ${r.status}`).trim().split(/\r?\n/).slice(0, 3).join(' ');
  throw new Error(why);
}

/**
 * The part of ChildProcess the runner uses, for a process the Board did not start itself: no exit
 * code (as with a run reattached after a restart, D45), 'exit' once the pid is gone.
 */
export class PolledProcess extends EventEmitter {
  private timer: NodeJS.Timeout;
  constructor(
    readonly pid: number,
    isAlive: (pid: number) => boolean,
    intervalMs = 500,
  ) {
    super();
    this.timer = setInterval(() => {
      if (isAlive(pid)) return;
      clearInterval(this.timer);
      this.emit('exit', null);
    }, intervalMs);
  }
  unref(): this {
    this.timer.unref();
    return this;
  }
}
