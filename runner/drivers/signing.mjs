/**
 * Request signing for device bridges that require it (docs/DEVICE_BRIDGE.md «Signed bridges»).
 *
 * A bridge that says `signatureRequired: true` in its hello refuses every command that is not signed with
 * a private key whose public half the app was built with. The scheme (protocol 2): four headers on each
 * request —
 *
 *   X-G9P-Kid    the key id (one of hello.kids)
 *   X-G9P-Ts     unix milliseconds
 *   X-G9P-Nonce  base64url of 16 random bytes
 *   X-G9P-Sig    base64url(DER ECDSA-P256-SHA256(key, "g9p2\n" + app + "\n" + ts + "\n" + nonce + "\n" +
 *                                                    METHOD + "\n" + path + "\n" + hex(sha256(body))))
 *
 * where `app` is the hello's `app`. Nothing here names a product: the key comes from the environment
 * (G9_SECRET_DEVICE_SIGNING_KEY — the runner's secret convention), a file, or the operating system's own
 * store, as the project's device profile says (`signing: { kid, key: { file, windows, macos } }`). The key
 * is never printed or written anywhere by this module.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export function privateKeyFrom(text) {
  const t = String(text ?? '').trim();
  if (t.includes('-----BEGIN')) return crypto.createPrivateKey(t);
  return crypto.createPrivateKey({ key: Buffer.from(t, 'base64'), format: 'der', type: 'pkcs8' });
}

export function signRequest({ key, kid, app, method, path, body = '', now = Date.now() }) {
  const nonce = b64url(crypto.randomBytes(16));
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  const text = ['g9p2', app, String(now), nonce, method.toUpperCase(), path, hash].join('\n');
  const sig = crypto.sign('sha256', Buffer.from(text, 'utf8'), key);
  return { 'X-G9P-Kid': kid, 'X-G9P-Ts': String(now), 'X-G9P-Nonce': nonce, 'X-G9P-Sig': b64url(sig) };
}

const WINDOWS_CRED_READ = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class G9RunnerCred {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct C { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int BlobSize; public IntPtr Blob; public int Persist; public int AttributeCount;
    public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CredRead(string t, int type, int f, out IntPtr c);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static string Read(string t) { IntPtr p; if (!CredRead(t, 1, 0, out p)) return null;
    try { var c=(C)Marshal.PtrToStructure(p, typeof(C)); var b=new byte[c.BlobSize]; Marshal.Copy(c.Blob, b, 0, c.BlobSize);
      return (c.BlobSize % 2 == 0 && c.BlobSize > 1 && b[1]==0) ? Encoding.Unicode.GetString(b) : Encoding.UTF8.GetString(b); } finally { CredFree(p); } }
}
'@
$v=[G9RunnerCred]::Read($env:G9_CRED_TARGET); if ($v) { [Console]::Out.Write($v) } else { exit 3 }
`;

function quietly(fn) {
  try {
    return fn() || null;
  } catch {
    return null;
  }
}

/**
 * The signing key for a device profile: {key: KeyObject, kid, source} or null. Order: the environment
 * (G9_SECRET_DEVICE_SIGNING_KEY), then the profile's `signing.key.file`, then the OS store it names
 * (`windows`: a Credential Manager target; `macos`: {service, account} in the login keychain).
 */
export function signingFor(profile, env = process.env) {
  const signing = profile?.signing ?? {};
  const ref = signing.key ?? {};
  let text = env.G9_SECRET_DEVICE_SIGNING_KEY ?? null;
  let source = text ? 'env:G9_SECRET_DEVICE_SIGNING_KEY' : null;
  if (!text && ref.file && fs.existsSync(ref.file)) {
    text = fs.readFileSync(ref.file, 'utf8').trim();
    source = `file:${ref.file}`;
  }
  if (!text && os.platform() === 'win32' && ref.windows) {
    text = quietly(() => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CRED_READ], {
      env: { ...env, G9_CRED_TARGET: ref.windows }, stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, windowsHide: true,
    }).toString('utf8').trim());
    if (text) source = `windows-credential:${ref.windows}`;
  }
  if (!text && os.platform() === 'darwin' && ref.macos?.service) {
    text = quietly(() => execFileSync('security', ['find-generic-password', '-s', ref.macos.service, '-a', ref.macos.account ?? '', '-w'], {
      stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000,
    }).toString('utf8').trim());
    if (text) source = `keychain:${ref.macos.service}`;
  }
  if (!text) return null;
  return { key: privateKeyFrom(text), kid: signing.kid ?? null, source };
}
