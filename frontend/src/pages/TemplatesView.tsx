import { renderTemplate } from '../components/templates'

// Hidden gallery for the reusable UI templates (naru task 1932): `#/templates`,
// reachable by address only, not in the nav or palette. Every template with
// sample data and its states.

const LONG =
  'https://example.com/a/very/long/path/that/never/breaks/' + 'segment-'.repeat(12) + ' and then some free text that goes on.'

const SECTIONS: { title: string; spec: unknown }[] = [
  { title: 'Card', spec: { type: 'card', title: 'Fix the export', body: 'Short body.', meta: ['task 1932', 'todo'] } },
  { title: 'Card, toned edge and link', spec: { type: 'card', title: 'Cost alert', body: 'Over budget.', tone: 'warn', href: '#/kb' } },
  { title: 'Card, violet edge', spec: { type: 'card', title: 'Change request', edge: 'violet', meta: ['inbox'] } },
  { title: 'Card, long text', spec: { type: 'card', title: LONG, body: LONG, meta: [LONG] } },
  {
    title: 'Table',
    spec: {
      type: 'table',
      columns: [
        { key: 'name', label: 'Name', sortable: true },
        { key: 'runs', label: 'Runs', sortable: true },
        { key: 'cost', label: 'Cost', sortable: true },
        { key: 'note', label: 'Note' },
      ],
      rows: [
        { id: 'a', name: 'alpha', runs: 12, cost: 3.5, note: 'ok' },
        { id: 'b', name: 'beta', runs: 340, cost: 0.25, note: null },
        { id: 'c', name: 'gamma', runs: 7, cost: 19, note: LONG },
      ],
      rowKey: 'id',
      initialSort: { key: 'runs' },
    },
  },
  { title: 'Table, empty', spec: { type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [], empty: 'No rows yet.' } },
  {
    title: 'Panel with stats and a callout',
    spec: {
      type: 'panel',
      title: 'Overview',
      hint: 'Last 24 hours',
      children: [
        { type: 'stat', label: 'Sessions', value: 42, sub: '+3 today' },
        { type: 'stat', label: 'Errors', value: 2, tone: 'bad' },
        { type: 'stat', label: 'Healthy', value: '98%', tone: 'good' },
        { type: 'callout', tone: 'info', text: 'Numbers refresh every minute.' },
      ],
    },
  },
  { title: 'Panel, empty', spec: { type: 'panel', title: 'Nothing here' } },
  { title: 'Stat, long label', spec: { type: 'stat', label: LONG, value: '1,234,567', sub: LONG, tone: 'warn' } },
  { title: 'Callout, info', spec: { type: 'callout', tone: 'info', title: 'Heads up', text: 'A neutral piece of news.' } },
  { title: 'Callout, good', spec: { type: 'callout', tone: 'good', text: 'Saved.' } },
  { title: 'Callout, warn', spec: { type: 'callout', tone: 'warn', title: 'Slow', text: 'This may take a while.' } },
  { title: 'Callout, error', spec: { type: 'callout', tone: 'bad', title: 'Failed', text: 'Could not reach the server.' } },
  { title: 'Callout, long text', spec: { type: 'callout', tone: 'neutral', text: LONG } },
  {
    title: 'List with detail',
    spec: {
      type: 'list-detail',
      items: [
        { id: 'one', title: 'First note', group: 'Alpha', meta: ['2026-10-01', 'tag'] },
        { id: 'two', title: 'Second note', group: 'Alpha' },
        { id: 'three', title: LONG, group: 'Beta' },
      ],
      details: {
        one: { title: 'First note', body: 'Some **markdown** with a list:\n\n- a\n- b\n\n`code`' },
        two: { body: 'Plain body.' },
        three: { title: 'Long', body: LONG },
      },
      selectedId: 'one',
    },
  },
  { title: 'List with detail, empty', spec: { type: 'list-detail', items: [], details: {}, emptyList: 'No notes.' } },
  { title: 'Unknown type', spec: { type: 'hologram', title: 'x' } },
  { title: 'Invalid spec', spec: { type: 'card' } },
]

export function TemplatesView() {
  return (
    <div className="templates-page">
      <h1>Templates</h1>
      <p className="muted">Reusable UI blocks with sample data. Not linked from the nav.</p>
      {SECTIONS.map((s) => (
        <section key={s.title} style={{ marginBottom: '1.5rem' }}>
          <h2>{s.title}</h2>
          {renderTemplate(s.spec)}
        </section>
      ))}
    </div>
  )
}
