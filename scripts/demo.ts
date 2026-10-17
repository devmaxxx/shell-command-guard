// Renders assets/demo.svg: an animated terminal that types each command and prints what `deniedBy` really returns for
// it, so the README demo cannot drift from the library. Run with `pnpm demo`.
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { DEFAULT_DENY, deniedBy } from '../src'

const COMMANDS = [
  'grep "git push" notes.md',
  'env FOO=1 git push origin main',
  'bash -c "pnpm test && git push"',
  'echo origin | xargs git push',
  'g\'i\'t push --force',
  'echo \'git push\' | sh',
  'python3 -c "import os; os.system(\'git push\')"',
  'rm -r -f /',
  'pnpm test && git commit -m "push later"',
]

const FONT_SIZE = 14
// Monospace fonts set at 14px advance about 8.4px per character; the cover over a typed line is sized from this, and
// textLength pins the rendered text to the same width so a fallback font cannot peek out past the cover.
const CHAR_WIDTH = 8.4
const LINE_HEIGHT = 22
const PAD_X = 20
const TITLE_BAR = 36
const WIDTH = 760
const TYPE_SECONDS_PER_CHAR = 0.035
const PAUSE_BEFORE_VERDICT = 0.35
const PAUSE_AFTER_VERDICT = 0.9
const HOLD_AT_END = 3

const COLORS = {
  window: '#0d1117',
  bar: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  muted: '#7d8590',
  prompt: '#58a6ff',
  denied: '#ff7b72',
  allowed: '#3fb950',
}

function escapeXml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function pct(seconds: number, total: number): string {
  return `${((seconds / total) * 100).toFixed(3)}%`
}

interface Step {
  cmd: string
  verdict: string | null
  typeStart: number
  typeEnd: number
  verdictAt: number
}

function schedule(): { steps: Step[], total: number } {
  let t = 0.6
  const steps = COMMANDS.map((cmd) => {
    const typeStart = t
    const typeEnd = typeStart + cmd.length * TYPE_SECONDS_PER_CHAR
    const verdictAt = typeEnd + PAUSE_BEFORE_VERDICT
    t = verdictAt + PAUSE_AFTER_VERDICT
    return { cmd, verdict: deniedBy(cmd, DEFAULT_DENY), typeStart, typeEnd, verdictAt }
  })

  return { steps, total: t + HOLD_AT_END }
}

function render(): string {
  const { steps, total } = schedule()
  const bodyTop = TITLE_BAR + 18
  const height = bodyTop + (steps.length * 2 + 2) * LINE_HEIGHT
  const css: string[] = []
  const lines: string[] = []

  lines.push(
    `<text x="${PAD_X}" y="${bodyTop + 4}" fill="${COLORS.muted}">// deniedBy(cmd, DEFAULT_DENY) for each line</text>`,
  )

  steps.forEach((step, i) => {
    const y = bodyTop + (i * 2 + 2) * LINE_HEIGHT - LINE_HEIGHT / 2
    const textX = PAD_X + 2 * CHAR_WIDTH
    const coverWidth = step.cmd.length * CHAR_WIDTH + CHAR_WIDTH
    const verdict = step.verdict === null
      ? `<tspan fill="${COLORS.allowed}">✓ allowed</tspan>`
      : `<tspan fill="${COLORS.denied}">✗ denied</tspan>  <tspan fill="${COLORS.text}">${escapeXml(JSON.stringify(step.verdict))}</tspan>`

    css.push(
      `.c${i}{animation:c${i} ${total.toFixed(2)}s infinite}`,
      `@keyframes c${i}{0%,${pct(step.typeStart, total)}{transform:translateX(0);animation-timing-function:steps(${step.cmd.length},end)}`
      + `${pct(step.typeEnd, total)},100%{transform:translateX(${coverWidth.toFixed(1)}px)}}`,
      `.v${i},.p${i}{animation:v${i} ${total.toFixed(2)}s infinite;animation-timing-function:step-end}`,
      `.p${i}{animation-name:p${i}}`,
      `@keyframes v${i}{0%,${pct(step.verdictAt, total)}{opacity:0}${pct(step.verdictAt + 0.001, total)},100%{opacity:1}}`,
      `@keyframes p${i}{0%,${pct(step.typeStart, total)}{opacity:0}${pct(step.typeStart + 0.001, total)},100%{opacity:1}}`,
    )

    lines.push(
      `<text class="p${i}" x="${PAD_X}" y="${y}" fill="${COLORS.prompt}">❯</text>`,
      `<text x="${textX}" y="${y}" fill="${COLORS.text}" textLength="${(step.cmd.length * CHAR_WIDTH).toFixed(1)}" lengthAdjust="spacing" xml:space="preserve">${escapeXml(step.cmd)}</text>`,
      `<rect class="cover c${i}" x="${textX - 1}" y="${y - LINE_HEIGHT + 4}" width="${coverWidth.toFixed(1)}" height="${LINE_HEIGHT + 2}" fill="${COLORS.window}" shape-rendering="crispEdges"/>`,
      `<text class="v${i}" x="${textX}" y="${y + LINE_HEIGHT}" xml:space="preserve">${verdict}</text>`,
    )
  })

  const dots = [['#ff5f57', 20], ['#febc2e', 40], ['#28c840', 60]] as const

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-label="shell-guards demo: deniedBy allows commands that only mention git push and denies the ones that run it through env, bash -c, xargs, quoting, a stdin shell or python">
<style>
text{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace;font-size:${FONT_SIZE}px}
.fade{animation:fade ${total.toFixed(2)}s infinite}
@keyframes fade{0%,${pct(total - 0.4, total)}{opacity:1}100%{opacity:0}}
${css.join('\n')}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.cover{display:none}}
</style>
<rect x="0.5" y="0.5" width="${WIDTH - 1}" height="${height - 1}" rx="10" fill="${COLORS.window}" stroke="${COLORS.border}"/>
<path d="M0.5 ${TITLE_BAR} V10.5 a10 10 0 0 1 10 -10 H${WIDTH - 10.5} a10 10 0 0 1 10 10 V${TITLE_BAR} Z" fill="${COLORS.bar}"/>
${dots.map(([fill, cx]) => `<circle cx="${cx}" cy="${TITLE_BAR / 2}" r="6" fill="${fill}"/>`).join('')}
<text x="${WIDTH / 2}" y="${TITLE_BAR / 2 + 5}" fill="${COLORS.muted}" text-anchor="middle">shell-guards</text>
<g class="fade">
${lines.join('\n')}
</g>
</svg>
`
}

const out = new URL('../assets/demo.svg', import.meta.url)
writeFileSync(out, render())
process.stdout.write(`wrote ${out.pathname}\n`)
