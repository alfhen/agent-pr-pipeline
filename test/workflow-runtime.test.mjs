// Token scan of workflows/run-wave.js for calls the Workflow runtime forbids (Date.now, Math.random, argless new Date).
// Aliases such as `const { now } = Date` are not found; the runtime guard in sim-pipeline.mjs is the net for those.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WORKFLOW = fileURLToPath(new URL('../workflows/run-wave.js', import.meta.url))
const VALUE_END_PUNCT = new Set([')', ']', '}'])
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await'])
const idStart = c => /[A-Za-z_$]/.test(c)
const idPart = c => /[A-Za-z0-9_$]/.test(c)

export function tokenize(src) {
  const tokens = []
  const stack = [] // brace depth of each open `${` substitution
  let i = 0, line = 1, mode = 'code', tplStart = 0, tplLine = 1
  let unterminated = null
  const push = (type, value, ln) => tokens.push({ type, value, line: ln })
  const regexAllowed = () => {
    const p = tokens[tokens.length - 1]
    if (!p) return true
    if (p.type === 'punct') return !VALUE_END_PUNCT.has(p.value)
    if (p.type === 'ident') return REGEX_KEYWORDS.has(p.value)
    return false
  }
  while (i < src.length) {
    const c = src[i]
    if (mode === 'template') {
      if (c === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue }
      if (c === '\n') line++
      if (c === '`') { mode = 'code'; push('template', src.slice(tplStart, i + 1), tplLine); i++; continue }
      if (c === '$' && src[i + 1] === '{') { stack.push(0); mode = 'code'; push('punct', '${', line); i += 2; continue }
      i++; continue
    }
    if (c === '\n') { line++; i++; continue }
    if (/\s/.test(c)) { i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      if (end === -1) unterminated = 'block comment'
      for (const ch of src.slice(i, stop)) if (ch === '\n') line++
      i = stop; continue
    }
    if (c === '"' || c === "'") {
      const start = i, ln = line
      i++
      while (i < src.length && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\' && src[i + 1] === '\n') line++
        i += src[i] === '\\' ? 2 : 1
      }
      if (src[i] !== c) { unterminated = 'string'; push('string', src.slice(start + 1, i), ln); break }
      push('string', src.slice(start + 1, i), ln); i++; continue
    }
    if (c === '`') { mode = 'template'; tplStart = i; tplLine = line; i++; continue }
    if (c === '/' && regexAllowed()) {
      const start = i, ln = line
      let inClass = false
      i++
      while (i < src.length && src[i] !== '\n') {
        const ch = src[i]
        if (ch === '\\') { i += 2; continue }
        if (ch === '[') inClass = true
        else if (ch === ']') inClass = false
        else if (ch === '/' && !inClass) break
        i++
      }
      if (src[i] !== '/') { unterminated = 'regex'; break }
      i++
      while (i < src.length && idPart(src[i])) i++
      push('regex', src.slice(start, i), ln); continue
    }
    if (idStart(c)) {
      const start = i
      while (i < src.length && idPart(src[i])) i++
      push('ident', src.slice(start, i), line); continue
    }
    if (/[0-9]/.test(c)) {
      const start = i
      while (i < src.length && /[0-9A-Za-z_.]/.test(src[i])) i++
      push('number', src.slice(start, i), line); continue
    }
    if (c === '{' && stack.length) stack[stack.length - 1]++
    if (c === '}' && stack.length) {
      if (stack[stack.length - 1] === 0) { stack.pop(); mode = 'template'; tplStart = i; tplLine = line; i++; continue }
      stack[stack.length - 1]--
    }
    push('punct', c, line); i++
  }
  if (mode === 'template') unterminated = 'template literal'
  return { tokens, unterminated, openSubstitutions: stack.length, endMode: mode }
}

export function findForbidden(src) {
  const { tokens } = tokenize(src)
  const lines = src.split('\n')
  const hits = []
  const hit = (line, what) => hits.push({ line, what, text: lines[line - 1].trim() })
  const t = (k, n) => tokens[k + n]
  const is = (tok, type, value) => tok && tok.type === type && (value === undefined || tok.value === value)
  for (let k = 0; k < tokens.length; k++) {
    const tok = tokens[k]
    if (tok.type !== 'ident' || is(t(k, -1), 'punct', '.')) continue
    if (tok.value === 'Date' || tok.value === 'Math') {
      const bad = tok.value === 'Date' ? 'now' : 'random'
      const chain = is(t(k, 1), 'punct', '?') && is(t(k, 2), 'punct', '.') ? 2 : is(t(k, 1), 'punct', '.') ? 1 : 0
      if (chain && is(t(k, chain + 1), 'ident', bad)) hit(tok.line, `${tok.value}.${bad}`)
      else if (chain && is(t(k, chain + 1), 'punct', '[') && is(t(k, chain + 2), 'string', bad) && is(t(k, chain + 3), 'punct', ']')) hit(tok.line, `${tok.value}['${bad}']`)
      else if (is(t(k, 1), 'punct', '[') && is(t(k, 2), 'string', bad) && is(t(k, 3), 'punct', ']')) hit(tok.line, `${tok.value}['${bad}']`)
    }
    if (tok.value === 'new') {
      const wrapped = is(t(k, 1), 'punct', '(') && is(t(k, 2), 'ident', 'Date') && is(t(k, 3), 'punct', ')')
      if (wrapped || is(t(k, 1), 'ident', 'Date')) {
        const at = k + (wrapped ? 4 : 2)
        if (!is(t(k, at - k), 'punct', '(') || is(t(k, at - k + 1), 'punct', ')')) hit(tok.line, 'new Date without an argument')
      }
    }
  }
  return hits
}

export function preconditions(src, { anchors = true, regexWithBacktick = true } = {}) {
  const { tokens, unterminated, openSubstitutions, endMode } = tokenize(src)
  const problems = []
  if (unterminated) problems.push(`scanner ended inside a ${unterminated}`)
  if (endMode !== 'code') problems.push(`scanner ended in ${endMode} state`)
  if (openSubstitutions) problems.push('template stack is not empty')
  if (anchors) {
    const seq = (k, ...vals) => vals.every((v, n) => tokens[k + n] && tokens[k + n].type !== 'string' && tokens[k + n].type !== 'template' && tokens[k + n].value === v)
    let landFor = false, lastFinish = -1
    for (let k = 0; k < tokens.length; k++) {
      if (seq(k, 'async', 'function', 'landFor')) landFor = true
      if (seq(k, 'return', 'finish', '(')) lastFinish = k
    }
    if (!landFor) problems.push('anchor "async function landFor" not found in code')
    if (lastFinish === -1) problems.push('anchor "return finish(" not found in code')
  }
  if (regexWithBacktick && !tokens.some(x => x.type === 'regex' && x.value.includes('`'))) problems.push('no regex literal with a backtick was seen')
  return problems
}

const scan = s => findForbidden(s).map(h => h.line)

test('refuses each listed form, with its line number', () => {
  for (const s of ['const t = Date.now', "Date['now']()", 'new Date', 'new Date( )', 'new Date(/* x */)', 'x = Math.random', "Math['random']()", 'Date.now()', 'Math.random()', 'new Date\n',
    'Date?.now()', 'Math?.random()', "Date?.['now']()", "Math?.['random']()", 'new (Date)()', 'new (Date)', 'new Date ()', 'new (Date) ( )']) {
    assert.deepEqual(scan(`\n${s}`), [2], s)
  }
})

test('allows comments, prompt text, strings and new Date(argument)', () => {
  for (const s of ['// Date.now()', '/* Math.random() */', '`Date.now()`', "'Date[\"now\"]'", '"new Date()"', 'new Date(ms)', 'new Date(0)', 'x.Date.now', 'const d = Date.UTC(1)', 'new (Date)(ms)', 'x?.Date?.now', '`Date?.now()`']) {
    assert.match(s, /\b(Date|Math)\b/, `${s} holds the text the scan looks for`)
    assert.deepEqual(scan(s), [], s)
  }
  for (const s of ['// Date.now()', '/* Math.random() */', '`Date.now()`', "'Date[\"now\"]'", '"new Date()"', 'x.Date.now']) {
    assert.match(s, /Date\.now|Date\[|Math\.random|new Date\(\)/, `${s} holds the forbidden text`)
  }
})

test('a regex literal after any punctuator or keyword that cannot end a value does not open a template', () => {
  for (const s of ['f = x => /`/.test(x)', 'a = b + /`/.source', 'a = b - /`/.source', 'a = b * /`/.source', 'a = b < /`/.source', 'a = b > /`/.source',
    'a = typeof /`/', 'switch (x) { case /`/: }', 'a = b ? /`/ : c', 'for (const r of /`/g) {}', 'a = await /`/', 'a = !/`/.test(x)']) {
    assert.deepEqual(scan(`${s}\nDate.now()`), [s.split('\n').length + 1], s)
  }
})

test('counts a line continuation inside a quoted string', () => {
  assert.deepEqual(scan("const s = 'a\\\nb'\nDate.now()"), [3])
})

test('refuses code inside template substitutions, including nested ones', () => {
  assert.deepEqual(scan('`a ${Date.now()} b`'), [1])
  assert.deepEqual(scan('`${a ? `x` : Date.now()}`'), [1])
  assert.deepEqual(scan('`${ {a: 1}.a } ${Math.random()}`'), [1])
  assert.deepEqual(scan('`a\nDate.now()\n${b}`'), [])
})

test('a regex literal with a backtick does not open a template', () => {
  assert.deepEqual(scan('const r = /`/g\nDate.now()'), [2])
  assert.deepEqual(scan('x.replace(/`+/g, "")\nDate.now()'), [2])
  assert.deepEqual(scan('a = b / c\n`x`\nDate.now()'), [3])
  assert.deepEqual(scan('const r = /[/`]/\nMath.random()'), [2])
})

test('fixture inputs contain what the checks look for', () => {
  assert.ok(tokenize('/`/g').tokens.some(x => x.type === 'regex' && x.value.includes('`')))
  assert.ok(tokenize('`${a ? `x` : y}`').tokens.some(x => x.value === '${'))
  assert.equal(findForbidden('Date.now()')[0].text, 'Date.now()')
})

test('preconditions fail when the scanner ends inside a template', () => {
  const problems = preconditions('async function landFor() {}\nconst r = /`/\n`open ${x}')
  assert.ok(problems.some(p => /template/.test(p)), problems.join('; '))
  assert.deepEqual(preconditions('async function landFor() {}\nconst r = /`/\nreturn finish(1)\n'), [])
  assert.ok(preconditions('/* open').some(p => /block comment/.test(p)))
  assert.ok(preconditions("'open").some(p => /string/.test(p)))
})

test('preconditions fail when an anchor or the backtick regex is missing', () => {
  assert.ok(preconditions('const r = /`/\nreturn finish(1)').some(p => /landFor/.test(p)))
  assert.ok(preconditions('async function landFor() {}\nconst r = /`/').some(p => /finish/.test(p)))
  assert.ok(preconditions('async function landFor() {}\nreturn finish(1)').some(p => /backtick/.test(p)))
  assert.ok(preconditions('// async function landFor\nconst s = "return finish("\nconst r = /`/').length >= 2)
})

test('workflows/run-wave.js has no forbidden call and the scanner kept its place', () => {
  const src = readFileSync(WORKFLOW, 'utf8')
  assert.deepEqual(preconditions(src), [])
  assert.deepEqual(findForbidden(src).map(h => `${h.line}: ${h.what}: ${h.text}`), [])
})
