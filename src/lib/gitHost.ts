// Where a repository's deploy keys are managed, from its clone URL, and the
// SHA256 fingerprint git hosts list keys by.

export interface DeployKeyPage {
  host: "GitHub" | "GitLab" | "Bitbucket";
  url: string;
}

/** `git@host:a/b.git`, `ssh://git@host:22/a/b.git` or `https://host/a/b.git`. */
function parseRepo(repo: string): { host: string; path: string } | null {
  const r = repo.trim();
  const m = /^[a-z+]+:\/\//i.test(r)
    ? r.match(/^(?:https?|ssh|git\+ssh):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i)
    : r.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+?)(?:\.git)?\/?$/);
  if (!m || !m[1] || !m[2] || !m[2].includes("/")) return null;
  return { host: m[1].toLowerCase(), path: m[2] };
}

/** The deploy-keys settings page. An ssh alias like `work.github.com` counts as
 *  GitHub; any other host is taken as a GitLab at https://<host>. */
export function deployKeyPage(repo: string): DeployKeyPage | null {
  const p = parseRepo(repo);
  if (!p) return null;
  if (p.host === "github.com" || p.host.endsWith(".github.com")) return { host: "GitHub", url: `https://github.com/${p.path}/settings/keys` };
  if (p.host === "bitbucket.org") return { host: "Bitbucket", url: `https://bitbucket.org/${p.path}/admin/access-keys/` };
  return { host: "GitLab", url: `https://${p.host}/${p.path}/-/settings/repository#js-deploy-keys-settings` };
}

/** `SHA256:…` as `ssh-keygen -l` prints it (null if the line isn't a key). */
export async function keyFingerprint(line: string): Promise<string | null> {
  const blob = line.trim().split(/\s+/)[1];
  if (!blob) return null;
  try {
    const bytes = Uint8Array.from(atob(blob), (c) => c.charCodeAt(0));
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    return `SHA256:${btoa(String.fromCharCode(...hash)).replace(/=+$/, "")}`;
  } catch {
    return null;
  }
}
