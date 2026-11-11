import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The installer stores the device token encrypted with Windows DPAPI (machine scope) in a file only the
 * service account and administrators can read. Node has no DPAPI binding, so decryption goes through the
 * PowerShell that ships with Windows. The token is held in memory only and never logged.
 */
const UNPROTECT_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  'Add-Type -AssemblyName System.Security',
  '$b=[Convert]::FromBase64String([IO.File]::ReadAllText($env:XLW_TOKEN_FILE).Trim())',
  '$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::LocalMachine)',
  '[Text.Encoding]::UTF8.GetString($p)',
].join(';');

export async function readDeviceToken(tokenFile: string): Promise<string | null> {
  if (!existsSync(tokenFile)) return null;
  if (process.platform !== 'win32') {
    // Development machines: a plain-text file is accepted off Windows only.
    return readFileSync(tokenFile, 'utf8').trim() || null;
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', UNPROTECT_SCRIPT],
      { env: { ...process.env, XLW_TOKEN_FILE: tokenFile }, windowsHide: true, timeout: 30_000 },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
