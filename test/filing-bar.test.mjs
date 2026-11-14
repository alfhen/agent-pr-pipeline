// The filing bar: schema fields, role-file text and SKILL.md text that no runtime test reaches.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const src = read('workflows/run-wave.js')
const skill = read('skills/pr-pipeline/SKILL.md')

const constText = name => {
  const start = src.indexOf(`const ${name} = {`)
  assert.notEqual(start, -1, `no const ${name}`)
  const next = src.indexOf('\nconst ', start + 1)
  return src.slice(start, next)
}
const propText = (text, prop) => {
  const m = new RegExp(`\\b${prop}: ([A-Z_]+|\\{[^}]*\\})`).exec(text)
  return m ? m[1] : null
}
const descriptionOf = ref => {
  if (ref.startsWith('{')) return /description: '([^']*)'/.exec(ref)?.[1] || ''
  return /description: '([^']*)'/.exec(constText(ref))?.[1] || ''
}

test('the finding items of REVIEW, ARCHREV and QA take input and outcome, each with a description', () => {
  for (const name of ['REVIEW', 'ARCHREV', 'QA']) {
    const text = constText(name)
    assert.match(text, /fileIssue: \{ type: 'boolean' \}/, name);
    for (const prop of ['input', 'outcome']) {
      const ref = propText(text, prop)
      assert.ok(ref, `${name} has no ${prop}`)
      assert.notEqual(descriptionOf(ref).trim(), '', `${name} ${prop} has no description`)
    }
  }
})

const blocksOf = text => {
  const out = []
  for (const para of text.split(/\n\s*\n/)) {
    const items = para.split('\n').filter(l => /^\s*(-|\d+\.)\s/.test(l))
    if (items.length) out.push(...items.map(l => l.trim()))
    else out.push(para)
  }
  return out
}
const markBlock = file => {
  const found = blocksOf(read(file)).filter(b => b.includes('fileIssue: true'))
  assert.equal(found.length, 1, `${file} has ${found.length} blocks with fileIssue: true`)
  return found[0]
}
const ROLE_FILES = ['agents/reviewer.md', 'agents/arch-reviewer.md', 'agents/docs-reviewer.md', 'agents/qa.md']
const BELOW_THE_BAR = ['wording', 'naming', 'consistency', 'test strength', 'a missing test', 'drift', 'error text']

test('each role file gives the bar in the one block that sets the mark', () => {
  for (const file of ROLE_FILES) {
    const b = markBlock(file)
    for (const w of ['real effect', '`input`', '`outcome`', 'checklist', ...BELOW_THE_BAR]) assert.ok(b.includes(w), `${file}: ${w}`)
    const sentences = b.split(/(?<=\.)\s/)
    assert.ok(sentences.some(s => s.includes('not filed') && (s.includes('both') || (s.includes('input') && s.includes('outcome')))), `${file}: not filed sentence`)
    assert.ok(sentences.some(s => s.includes('minor') && (s.includes('no mark') || s.includes('unmarked'))), `${file}: unmarked sentence`)
  }
  const docs = markBlock('agents/docs-reviewer.md')
  assert.ok(docs.includes('follows') && (docs.includes('command') || docs.includes('step')))
})

const reviewerLines = read('agents/reviewer.md').split('\n')

test('the rank list of the reviewer has one line for a finding against the entry', () => {
  const from = reviewerLines.findIndex(l => l.startsWith('Rank each finding:'))
  const to = reviewerLines.findIndex(l => l.includes('fileIssue: true'))
  assert.ok(from !== -1 && to > from)
  const hits = reviewerLines.slice(from, to).filter(l => ['at least major', 'Touches', 'never a minor', 'whole change'].every(w => l.includes(w)))
  assert.equal(hits.length, 1)
  assert.doesNotMatch(hits[0], /untrusted text|minor-pass check/)
})

test('the minor-pass sentence of the reviewer and the task of the check carry the same exception', () => {
  const line = reviewerLines.find(l => l.includes('minor-pass check'))
  assert.ok(line)
  for (const w of ['at least major', 'does not do what its entry', 'outsidePass: true']) assert.ok(line.includes(w), w)
  const start = src.indexOf('const minorReviewPrompt')
  const task = src.slice(start, src.indexOf('\nconst ', start + 1))
  for (const w of ['at least major', 'does not do what its entry', 'outsidePass: true']) assert.ok(task.includes(w), w)
})

test('OUTSIDE_PASS names both kinds of finding about code outside the pass', () => {
  const d = /description: '([^']*)'/.exec(src.slice(src.indexOf('const OUTSIDE_PASS')))[1]
  for (const w of ['outside the commits of the pass', 'untrusted-path', 'does not do what its entry']) assert.ok(d.includes(w), w)
})

test('the second exception marks only a finding about code outside the commits of the pass', () => {
  const start = src.indexOf('const minorReviewPrompt')
  const task = src.slice(start, src.indexOf('\nconst ', start + 1))
  const inTask = task.split(/(?<=\.)\s/).find(s => s.includes('does not do what its entry'))
  const inRole = read('agents/reviewer.md').split(/(?<=\.)\s/).find(s => s.includes('does not do what its entry') && s.includes('outsidePass'))
  for (const sentence of [inTask, inRole]) {
    assert.ok(sentence)
    assert.match(sentence, /outsidePass: true\\?`? only when it is about code outside the commits of the pass/)
  }
})

const stepLines = (() => {
  const lines = skill.split('\n')
  const from = lines.findIndex(l => l.startsWith('## ') && l.includes('The loop for one PR'))
  assert.notEqual(from, -1)
  const rest = lines.slice(from + 1)
  const end = rest.findIndex(l => l.startsWith('## '))
  return end === -1 ? rest : rest.slice(0, end)
})()
const step = n => stepLines.find(l => l.startsWith(`${n}. `))

test('SKILL.md gives the bar in step 9 only', () => {
  const nine = step(9)
  for (const w of ['real effect', 'input', 'outcome', 'notFiled', ...BELOW_THE_BAR]) assert.ok(nine.includes(w), w)
  assert.deepEqual(stepLines.filter(l => l.includes('notFiled')), [nine])
})

test('SKILL.md step 3 gives the rank rule and the plan conflict sentence for a blocker or major', () => {
  const three = step(3)
  const sentences = three.split(/(?<=\.)\s/)
  assert.equal(sentences.filter(s => s.includes('at least major') && s.includes("outside the entry's Touches line")).length, 1)
  assert.ok(sentences.find(s => s.includes('plan conflict:')).includes('blocker or major'))
})

test('SKILL.md sends the minors of a fits verdict and the late minors to the checklist', () => {
  const five = stepLines.find(l => l.includes('**needs-change:**'))
  assert.ok(five.includes('checklist') && !five.includes('issue list'))
  const row = skill.split('\n').find(l => l.startsWith('| `lateMinors`'))
  const para = skill.split('\n').find(l => l.startsWith('After a wave'))
  for (const t of [row, para]) { assert.ok(t.includes('fileIssue')); assert.ok(t.includes('checklist')) }
})
