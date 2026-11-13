/**
 * A Windows file share typed by the person: \\server\share\path or smb://server/share/path → UNC path.
 * Only plain host and path characters are accepted. Never used for links in pages: opening a share can make
 * Windows sign in to that server with the person's account.
 */
export function shareTarget(input: string): string | null {
  const text = input.trim();
  let host: string;
  let rest: string[];
  const smb = /^smb:\/\/([^/\\?#]+)\/(.+)$/i.exec(text);
  const unc = /^\\\\([^\\/]+)\\(.+)$/.exec(text);
  if (smb) {
    host = smb[1];
    rest = decodeURIComponent(smb[2]).split('/').filter(Boolean);
  } else if (unc) {
    host = unc[1];
    rest = unc[2].split('\\').filter(Boolean);
  } else return null;
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(host) || host.startsWith('.') || !rest.length) return null;
  if (rest.some((p) => !p || p === '.' || p === '..' || /[\u0000-\u001f<>:"|?*\/\\]/.test(p))) return null;
  return `\\\\${host}\\${rest.join('\\')}`;
}
