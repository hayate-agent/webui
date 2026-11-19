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
