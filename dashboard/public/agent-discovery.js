// Independent discovery projection: a failed capability must not hide successful results.
export async function discoverAgent(request) {
  const [streams, projects] = await Promise.allSettled([
    request('streams', { action: 'list' }), request('projects', { action: 'list' })
  ]);
  return {
    ...(streams.status === 'fulfilled' ? streams.value : { streams: [] }),
    projects: projects.status === 'fulfilled' ? projects.value.projects ?? [] : [],
    unavailable: streams.status === 'rejected' && projects.status === 'rejected',
    incomplete: streams.status !== projects.status
  };
}

// A stream list from a PI agent carries no `projects`. Keep what is known and never leave
// the lists undefined: the sidebar filters them.
export function mergeSnapshot(previous, snapshot) {
  return { ...previous, ...snapshot, projects: snapshot?.projects ?? previous?.projects ?? [], streams: snapshot?.streams ?? previous?.streams ?? [] };
}
