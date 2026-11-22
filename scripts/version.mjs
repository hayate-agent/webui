/** Version of the WebUI bundle: `<package.json version>+<commits>.<short revision>`.
 * The commit count makes it count up with every change on main; the revision names the
 * exact source. Inputs, in order: HAYATE_WEBUI_REVISION/HAYATE_WEBUI_COMMITS (image builds
 * from a git-less archive), then the local git checkout, else an explicit `unknown`. */
export function webuiVersion({ git, pkg, env = {}, archived = '' }) {
  const base = /^\d+\.\d+\.\d+$/.test(pkg?.version ?? '') ? pkg.version : '0.0.0';
  let revision = /^[a-f0-9]{40}$/.test(env.HAYATE_WEBUI_REVISION ?? '') ? env.HAYATE_WEBUI_REVISION : undefined;
  let commits = /^[1-9]\d{0,8}$/.test(env.HAYATE_WEBUI_COMMITS ?? '') ? Number(env.HAYATE_WEBUI_COMMITS) : undefined;
  // `git archive` expands $Format:%H$ in scripts/revision.txt: a git-less build still knows its commit.
  if (revision === undefined && /^[a-f0-9]{40}$/.test(archived.trim())) revision = archived.trim();
  try {
    revision ??= git('rev-parse', 'HEAD');
    if (commits === undefined && git('rev-parse', '--is-shallow-repository') === 'false') commits = Number(git('rev-list', '--count', 'HEAD'));
  } catch { /* no git metadata: fall through to the explicit label */ }
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) return { version: `${base}+unknown`, revision: null, commits: null };
  const short = revision.slice(0, 7);
  return { version: Number.isSafeInteger(commits) ? `${base}+${commits}.${short}` : `${base}+${short}`, revision, commits: commits ?? null };
}
