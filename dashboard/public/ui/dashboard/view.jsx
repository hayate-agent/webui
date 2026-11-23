// Renders one dashboard program (OpenUI Lang) with our component library and the tool policy.
import { useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { Renderer } from '@openuidev/react-lang';
import { dashboardLibrary } from './library.jsx';
import { createToolProvider } from '../../dashboard-tools.js';

// The library's default loader injects a <style> element, which our CSP (style-src 'self') blocks.
// This one is plain Tailwind (animate-spin) and pinned to the top-right like the original.
const queryLoader = <div role="status" aria-label="Loading data" className="absolute right-2 top-2 size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />;

export function DashboardView({ source, streaming = false, mode, tools, call, confirm, audit, onError }) {
  const toolProvider = useMemo(() => createToolProvider({ mode, tools, call, confirm, audit }), [mode, tools, call, confirm, audit]);
  return <Renderer library={dashboardLibrary} response={source} isStreaming={streaming} toolProvider={toolProvider} queryLoader={queryLoader} onError={onError} />;
}
export function mountDashboard(element, props) {
  const root = createRoot(element); root.render(<DashboardView {...props} />);
  return { update: next => root.render(<DashboardView {...next} />), unmount: () => root.unmount() };
}
