import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { formatMoney } from '../money'

export interface WaterfallStep {
  name: string
  effect_cents: number
}

interface Datum {
  name: string
  kind: 'start' | 'up' | 'down' | 'end'
  range: [number, number]
  delta: number
  running: number
}

const FILL: Record<Datum['kind'], string> = {
  start: 'var(--track)',
  up: 'var(--good)',
  down: 'var(--bad)',
  end: 'var(--series-1)',
}

const tooltipStyle = {
  background: 'var(--surface)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  color: 'var(--ink)',
}

const signed = (cents: number) => `${cents > 0 ? '+' : ''}${formatMoney(cents)}`
const short = (name: string) => (name.length > 14 ? `${name.slice(0, 13)}…` : name)

function buildData(budget: number, steps: WaterfallStep[], actual: number): Datum[] {
  const data: Datum[] = [{ name: 'Budget NET', kind: 'start', range: [Math.min(0, budget), Math.max(0, budget)], delta: budget, running: budget }]
  let running = budget
  for (const s of steps) {
    const next = running + s.effect_cents
    data.push({
      name: s.name,
      kind: s.effect_cents >= 0 ? 'up' : 'down',
      range: [Math.min(running, next), Math.max(running, next)],
      delta: s.effect_cents,
      running: next,
    })
    running = next
  }
  data.push({ name: 'Actual NET', kind: 'end', range: [Math.min(0, actual), Math.max(0, actual)], delta: actual, running: actual })
  return data
}

function WaterfallTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Datum }> }) {
  if (!active || !payload?.length) return null
  const d = payload[0].payload
  return (
    <div style={{ ...tooltipStyle, padding: '8px 10px' }}>
      <b>{d.name}</b>
      <div className="small">{d.kind === 'start' || d.kind === 'end' ? formatMoney(d.delta) : `${signed(d.delta)} on NET`}</div>
      {d.kind !== 'start' && d.kind !== 'end' && <div className="small muted">NET so far {formatMoney(d.running)}</div>}
    </div>
  )
}

export function NetWaterfall({ budget, actual, steps }: { budget: number; actual: number; steps: WaterfallStep[] }) {
  const data = buildData(budget, steps, actual)
  return (
    <>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 20, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke="var(--line)" vertical={false} />
            <XAxis dataKey="name" stroke="var(--muted)" interval={0} tickFormatter={short} />
            <YAxis stroke="var(--muted)" tickFormatter={(v: number) => formatMoney(v)} width={72} />
            <ReferenceLine y={0} stroke="var(--muted)" />
            <Tooltip content={<WaterfallTooltip />} cursor={{ fill: 'var(--bg)' }} />
            <Bar dataKey="range" radius={[3, 3, 3, 3]} maxBarSize={56}>
              {data.map((d) => (
                <Cell key={d.name} fill={FILL[d.kind]} />
              ))}
              <LabelList
                dataKey="range"
                position="top"
                content={(props) => {
                  const { x, y, width, index } = props as { x: number; y: number; width: number; index: number }
                  const d = data[index]
                  if (!d) return null
                  const text = d.kind === 'start' || d.kind === 'end' ? formatMoney(d.delta) : signed(d.delta)
                  return (
                    <text x={x + width / 2} y={y - 6} textAnchor="middle" fill="var(--ink)" fontSize={12}>
                      {text}
                    </text>
                  )
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="legend-row small muted">
        <span className="swatch" style={{ background: 'var(--good)' }} /> Helped NET
        <span className="swatch" style={{ background: 'var(--bad)' }} /> Hurt NET
        <span className="swatch" style={{ background: 'var(--track)' }} /> Budget NET
        <span className="swatch" style={{ background: 'var(--series-1)' }} /> Actual NET
      </p>
    </>
  )
}
