// OpenUI component library for dashboards: only OUR shadcn components are registered, so a model
// can compose nothing else (an unknown component is dropped by the parser). Do not import
// `@openuidev/react-ui` here: it injects styles at runtime (goober), which our CSP forbids.
import { defineComponent, createLibrary, action, useTriggerAction } from '@openuidev/react-lang';
import { z } from 'zod/v4';
import { Card, CardContent, CardHeader, CardTitle } from '../shadcn/card';
import { Badge } from '../shadcn/badge';
import { Alert } from '../shadcn/alert';
import { buttonVariants } from '../shadcn/button';
import { cn } from '../../lib/utils';

const Stack = defineComponent({
  name: 'Stack', description: 'Container. direction "row" lays children side by side, "column" (default) stacks them.',
  props: z.object({ children: z.array(z.any()), direction: z.enum(['row', 'column']).optional() }),
  component: ({ props, renderNode }) => <div className={cn('flex gap-3', props.direction === 'row' ? 'flex-row flex-wrap' : 'flex-col')}>{renderNode(props.children)}</div>
});
const Panel = defineComponent({
  name: 'Panel', description: 'Titled card around other components.',
  props: z.object({ title: z.string(), children: z.array(z.any()) }),
  component: ({ props, renderNode }) => <Card><CardHeader><CardTitle>{props.title}</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">{renderNode(props.children)}</CardContent></Card>
});
const Metric = defineComponent({
  name: 'Metric', description: 'One key figure: a small label above a large value.',
  props: z.object({ label: z.string(), value: z.union([z.string(), z.number()]) }),
  component: ({ props }) => <div className="flex flex-col gap-1 rounded-lg border p-3"><span className="text-xs text-muted-foreground">{props.label}</span><span className="text-2xl font-semibold" data-metric={props.label}>{String(props.value)}</span></div>
});
const Tag = defineComponent({
  name: 'Tag', description: 'Small status label. variant: default | secondary | destructive | outline.',
  props: z.object({ text: z.string(), variant: z.enum(['default', 'secondary', 'destructive', 'outline']).optional() }),
  component: ({ props }) => <Badge variant={props.variant ?? 'secondary'}>{props.text}</Badge>
});
const Notice = defineComponent({
  name: 'Notice', description: 'Highlighted message for problems.',
  props: z.object({ text: z.string() }),
  component: ({ props }) => <Alert variant="destructive">{props.text}</Alert>
});
const Table = defineComponent({
  name: 'Table', description: 'Table. columns are header names, rows are arrays of cell values (same order as columns).',
  props: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number()]))) }),
  component: ({ props }) => (
    <table className="w-full text-left text-sm"><thead><tr>{props.columns.map(name => <th key={name} className="border-b p-2 font-medium">{name}</th>)}</tr></thead>
      <tbody>{props.rows.map((row, index) => <tr key={index}>{row.map((cell, i) => <td key={i} className="border-b p-2">{String(cell)}</td>)}</tr>)}</tbody></table>
  )
});
const Btn = defineComponent({
  name: 'Btn', description: 'Button. The second argument is its action, for example @Run(query) to refresh data.',
  props: z.object({ label: z.string(), action: action().optional() }),
  component: ({ props }) => <ActionButton label={props.label} plan={props.action} />
});
function ActionButton({ label, plan }) {
  const trigger = useTriggerAction();
  return <button type="button" className={buttonVariants({ variant: 'outline', size: 'sm' })} onClick={() => { void trigger(label, undefined, plan); }}>{label}</button>;
}

export const dashboardLibrary = createLibrary({ root: 'Stack', components: [Stack, Panel, Metric, Tag, Notice, Table, Btn] });
