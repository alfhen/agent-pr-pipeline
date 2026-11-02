export const meta = {
  name: 'run-wave',
  description: 'Build, test, review and fix one wave of PRs, open them and answer the review bots; each step a separate agent',
  phases: [
    { title: 'Preflight', detail: 'check the goals document exists and has goals and non-goals' },
    { title: 'Implement', detail: 'one agent builds each PR on its own branch' },
    { title: 'Test', detail: 'a second agent runs the fast checks and the PR\'s own e2e from a clean clone' },
    { title: 'Review', detail: 'a stronger model reviews the diff adversarially' },
    { title: 'Product fit', detail: 'a stronger model checks a plan against the product goals and non-goals, and asks a person when it diverges' },
    { title: 'QA', detail: 'an agent uses the built feature like a user and checks it does what the plan entry and the docs say' },
    { title: 'Architecture', detail: 'a stronger model checks the PR against the architecture, and asks a person when the architecture itself should change' },
    { title: 'Fix', detail: 'an agent fixes blockers, majors and failing checks' },
    { title: 'Docs', detail: 'after sign-off, an agent updates the docs the change affects; a short round checks the new head' },
    { title: 'Open PR', detail: 'open the PR and file minor findings as issues' },
    { title: 'Bots', detail: 'a small agent waits for the review bots; another answers them only if they commented' },
    { title: 'Land fix', detail: 'only for PRs passed with landFix: resolve a conflict or a CI failure' },
  ],
}

// args: see SKILL.md, "Workflow arguments".
const A = args || {}
const REPO = A.repo
const TMP = A.tmp
const PLAN = A.plan
const SPEC = A.spec || ''
const ARCH = A.architecture || SPEC
const GOALS = A.goals
const FAST_CHECKS = A.checks || ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm typecheck', 'pnpm test']
const E2E_PATTERN = A.e2ePattern || '\\.e2e\\.test\\.ts$'
const E2E_COMMAND = A.e2eCommand || 'pnpm exec vitest run {files}'
const BOTS = A.bots || 'CodeRabbit (login coderabbitai) and Gitar (login contains "gitar")'
const BOT_WAIT_MIN = A.botWaitMinutes || 20
const LABEL = A.minorLabel || 'review-minor'
const MILESTONE = A.milestone ? ` --milestone "${A.milestone}"` : ''
const STEPS = Object.assign({
  impl: { model: 'sonnet', effort: 'medium' },
  test: { model: 'sonnet', effort: 'low' },
  review: { model: 'opus', effort: 'high' },
  arch: { model: 'opus', effort: 'high' },
  product: { model: 'opus', effort: 'high' },
  preflight: { model: 'haiku', effort: 'low' },
  reviewDocs: { model: 'sonnet', effort: 'high' },
  fix: { model: 'sonnet', effort: 'medium' },
  open: { model: 'sonnet', effort: 'low' },
  botWait: { model: 'haiku', effort: 'low' },
  botAnswer: { model: 'sonnet', effort: 'medium' },
  landFix: { model: 'sonnet', effort: 'medium' },
  docs: { model: 'sonnet', effort: 'medium' },
  qa: { model: 'sonnet', effort: 'medium' },
}, A.steps || {})
if (!REPO || !TMP || !PLAN || !Array.isArray(A.prs)) throw new Error('args needs repo, tmp, plan and prs')
if (!GOALS) throw new Error('args needs goals: the path to the product goals document (see templates/goals.md). The pipeline does not start without one.')

const SKILL_STEPS = ['impl', 'test', 'review', 'qa', 'arch', 'product', 'fix', 'docs', 'open', 'botAnswer', 'landFix', 'preflight']
const SECURITY_SKILL = A.securitySkill || 'security-review'
const checkSkills = (map, where) => {
  for (const [step, names] of Object.entries(map || {})) {
    if (!SKILL_STEPS.includes(step)) throw new Error(`${where}: unknown step "${step}". Use one of: ${SKILL_STEPS.join(', ')}`)
    if (!Array.isArray(names) || !names.every(n => typeof n === 'string' && /^[\w.-]+(:[\w.-]+)?$/.test(n))) {
      throw new Error(`${where}.${step} must be a list of skill names, for example ["humanizer:humanizer"]`)
    }
  }
}
checkSkills(A.skills, 'skills')
A.prs.forEach(pr => checkSkills(pr.skills, `prs[${pr.id}].skills`))
const skillsFor = (step, pr) => {
  const names = [...((A.skills || {})[step] || []), ...(((pr && pr.skills) || {})[step] || [])]
  if (step === 'review' && pr && pr.sensitive) names.push(SECURITY_SKILL)
  return [...new Set(names)]
}
const withSkills = (step, pr, prompt) => {
  const names = skillsFor(step, pr)
  if (!names.length) return prompt
  return `Before you do anything else, load these skills with the Skill tool: ${names.map(n => `\`${n}\``).join(', ')}. Follow them where they apply to your job below. If a skill cannot be loaded, go on without it and say so in your answer.

${prompt}`
}

const roundsFor = pr => pr.maxRounds || (pr.kind === 'plan' ? (A.planRounds || 2) : (A.maxRounds || 4))
const reviewStep = pr => (pr.kind === 'plan' || pr.kind === 'docs') ? STEPS.reviewDocs : STEPS.review
const productRuns = pr => A.productReview !== false && (pr.kind === 'plan' || (A.productReview === 'all' && pr.kind !== 'docs'))
const docsRuns = pr => pr.kind !== 'docs' && pr.kind !== 'plan' && A.docsUpdate !== false && pr.docsUpdate !== false
const DOCS_ROUNDS = A.docsRounds || 2
const qaRuns = pr => pr.kind !== 'docs' && pr.kind !== 'plan' && A.qa !== false && pr.qa !== false && (A.qa === 'all' || !!pr.qa)
const archRuns = pr => pr.kind !== 'docs' && !!ARCH && A.architectureReview !== false
const decided = pr => (pr.architectureDecision ? `\nArchitecture decision by the maintainer for this PR (settled; follow it): ${pr.architectureDecision}` : '')
  + (pr.productDecision ? `\nProduct scope decision by the maintainer for this PR (settled; follow it): ${pr.productDecision}` : '')
const AGENT_PREFIX = A.agentPrefix === undefined ? 'agent-pr-pipeline:' : A.agentPrefix
const ROLES = {
  impl: { agent: 'implementer', phase: 'Implement', isolation: 'worktree' },
  test: { agent: 'tester', phase: 'Test' },
  review: { agent: 'reviewer', phase: 'Review' },
  qa: { agent: 'qa', phase: 'QA' },
  arch: { agent: 'arch-reviewer', phase: 'Architecture' },
  product: { agent: 'product-reviewer', phase: 'Product fit' },
  fix: { agent: 'fixer', phase: 'Fix', isolation: 'worktree' },
  docs: { agent: 'docs-writer', phase: 'Docs', isolation: 'worktree' },
  docsReview: { agent: 'docs-reviewer', phase: 'Docs', skills: 'docs', model: 'reviewDocs' },
  open: { agent: 'pr-opener', phase: 'Open PR' },
  botWait: { agent: 'bot-waiter', phase: 'Bots', skills: null },
  botAnswer: { agent: 'bot-answerer', phase: 'Bots', isolation: 'worktree' },
  landFix: { agent: 'land-fixer', phase: 'Land fix', isolation: 'worktree' },
  preflight: { agent: 'goals-preflight', phase: 'Preflight' },
}
const call = (role, pr, prompt, label, extra) => {
  const r = ROLES[role]
  const skillStep = r.skills === undefined ? role : r.skills
  const step = role === 'review' ? reviewStep(pr) : STEPS[r.model || role]
  return agent(skillStep ? withSkills(skillStep, pr, prompt) : prompt, Object.assign(
    { agentType: AGENT_PREFIX + r.agent, model: step.model, effort: step.effort, label, phase: r.phase },
    r.isolation ? { isolation: r.isolation } : {},
    extra))
}

const CONTEXT = `Repo: ${REPO} (https://github.com/${REPO}).
${SPEC ? `Spec: ${SPEC}\n` : ''}Plan: ${PLAN}. The plan entry for this PR (its section, with its Touches and Acceptance lines) is the brief, plus the notes below. The plan's "Rules for every PR" section applies, and so do AGENTS.md or CLAUDE.md in the repo.
Temporary files go under ${TMP}/<your label>/. Never use /tmp.
${A.context || ''}`

const IMPL = {
  type: 'object',
  properties: {
    pushed: { type: 'boolean' }, branch: { type: 'string' }, headSha: { type: 'string' },
    summary: { type: 'string' }, acceptanceTestPassed: { type: 'boolean' }, problems: { type: 'string' },
  },
  required: ['pushed', 'branch', 'summary', 'acceptanceTestPassed'],
}
const TEST = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' }, headSha: { type: 'string' },
    checks: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, pass: { type: 'boolean' }, log: { type: 'string' } }, required: ['name', 'pass'] } },
  },
  required: ['pass', 'checks'],
}
const REVIEW = {
  type: 'object',
  properties: {
    headSha: { type: 'string' }, summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' }, file: { type: 'string' }, detail: { type: 'string' }, suggestedFix: { type: 'string' },
        },
        required: ['severity', 'title', 'detail'],
      },
    },
  },
  required: ['summary', 'findings'],
}
const ARCHREV = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['fits', 'needs-change', 'escalate'] },
    summary: { type: 'string' },
    newConcepts: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, where: { type: 'string' }, fits: { type: 'boolean' }, note: { type: 'string' } }, required: ['name', 'fits'] },
    },
    findings: {
      type: 'array',
      items: { type: 'object', properties: { title: { type: 'string' }, file: { type: 'string' }, detail: { type: 'string' }, suggestedFix: { type: 'string' } }, required: ['title', 'detail'] },
    },
    escalation: {
      type: 'object',
      properties: { question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } }, recommendation: { type: 'string' }, why: { type: 'string' } },
    },
  },
  required: ['verdict', 'summary', 'newConcepts'],
}
const QA = {
  type: 'object',
  properties: {
    headSha: { type: 'string' }, summary: { type: 'string' },
    scenarios: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' }, command: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, pass: { type: 'boolean' } }, required: ['name', 'pass'] },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          title: { type: 'string' }, command: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' }, detail: { type: 'string' },
        },
        required: ['severity', 'title', 'detail'],
      },
    },
  },
  required: ['summary', 'scenarios', 'findings'],
}
const PRODUCT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['aligned', 'notes', 'escalate'] },
    summary: { type: 'string' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          entry: { type: 'string' },
          fit: { type: 'string', enum: ['serves-goal', 'neutral', 'widens-scope', 'non-goal'] },
          goal: { type: 'string' },
          note: { type: 'string' },
          suggestion: { type: 'string', enum: ['keep', 'trim', 'defer', 'cut', 'change-goals'] },
        },
        required: ['entry', 'fit'],
      },
    },
    escalation: {
      type: 'object',
      properties: { question: { type: 'string' }, recommendation: { type: 'string' }, why: { type: 'string' } },
    },
  },
  required: ['verdict', 'summary', 'entries'],
}
const PREFLIGHT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    exists: { type: 'boolean' },
    goals: { type: 'number' },
    nonGoals: { type: 'number' },
    missing: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'exists', 'missing'],
}
const DOCS = {
  type: 'object',
  properties: {
    changed: { type: 'boolean' }, headSha: { type: 'string' }, summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
  required: ['changed', 'summary'],
}
const OPEN = {
  type: 'object',
  properties: { prNumber: { type: 'number' }, prUrl: { type: 'string' }, issuesCreated: { type: 'array', items: { type: 'string' } } },
  required: ['prNumber'],
}
const WAIT = {
  type: 'object',
  properties: {
    approvedBy: { type: 'array', items: { type: 'string' } },
    openComments: { type: 'number' },
    timedOut: { type: 'boolean' },
    notes: { type: 'string' },
  },
  required: ['approvedBy', 'openComments'],
}
const ANSWER = {
  type: 'object',
  properties: { threadsAddressed: { type: 'number' }, codeChanged: { type: 'boolean' }, substantiveChange: { type: 'boolean' }, headSha: { type: 'string' }, notes: { type: 'string' } },
  required: ['codeChanged', 'substantiveChange'],
}
const LANDFIX = {
  type: 'object',
  properties: { readyToMerge: { type: 'boolean' }, headSha: { type: 'string' }, notes: { type: 'string' } },
  required: ['readyToMerge', 'notes'],
}

const fastText = FAST_CHECKS.map(c => `\`${c}\``).join(', ')
const ownE2e = `the e2e test files this branch adds or changes (\`git diff --name-only --diff-filter=d origin/HEAD...HEAD | grep -E '${E2E_PATTERN}'\`), run with \`${E2E_COMMAND}\` where {files} is that list; skip this when the list is empty. Do not run the full e2e suite`
const prBlock = pr => `PR: ${pr.id} - ${pr.title}\nBranch: ${pr.branch}\nKind: ${pr.kind || 'code'}\nNotes for this PR:\n${pr.notes || '(none)'}${decided(pr)}`
const cloneTo = (dir, pr) => `\`rm -rf ${TMP}/${dir} && git clone https://github.com/${REPO}.git ${TMP}/${dir} && cd ${TMP}/${dir} && git checkout ${pr.branch}\``
const freshBranch = (prefix, pr, n) => `\`git fetch origin && git checkout -B ${prefix}-${pr.id}-r${n} origin/${pr.branch}\` (a new local name, because another worktree may hold ${pr.branch}). Push with \`git push origin HEAD:${pr.branch}\`.`

const implPrompt = pr => `${CONTEXT}

Task: implement this PR.
1. You are in a fresh git worktree. Run \`git fetch origin && git checkout -B ${pr.branch} origin/HEAD\`. If ${pr.branch} already exists on origin from an earlier attempt, build on it: \`git checkout -B ${pr.branch} origin/${pr.branch}\`.
2. Read ${SPEC ? `${SPEC}, ` : ''}${PLAN} and the code you will change.
3. Checks: ${fastText}, and ${ownE2e}.
4. Commit and \`git push -u origin ${pr.branch}\`.
Return pushed, branch, headSha, a short summary, whether the acceptance test passed, and any problems or open questions.

${prBlock(pr)}`

const testPrompt = (pr, round) => `${CONTEXT}

Task: test the branch from a clean clone.
1. \`rm -rf ${TMP}/test-${pr.id}-r${round} && git clone --branch ${pr.branch} https://github.com/${REPO}.git ${TMP}/test-${pr.id}-r${round}\` and cd there.
2. Run in order: ${fastText}. Then run ${ownE2e}.
Return pass, headSha, and one entry per check with the failing log excerpt.

${prBlock(pr)}`

const reviewPrompt = (pr, round, history) => `${CONTEXT}

Task: review the branch against ${SPEC ? `${SPEC} and ` : ''}${PLAN}.
Clone it: ${cloneTo(`review-${pr.id}-r${round}`, pr)}. The diff is \`git diff origin/HEAD...HEAD\`.
Return headSha, a summary and the findings.

${prBlock(pr)}
${history.length ? `\nEarlier rounds (check their blockers and majors are really fixed):\n${JSON.stringify(history, null, 1)}` : ''}`

const productPrompt = (pr, round) => `${CONTEXT}

Task: check that ${pr.kind === 'plan' ? 'this plan' : 'this PR'} stays true to the product goals in ${GOALS}.
Clone it: ${cloneTo(`product-${pr.id}-r${round}`, pr)}. Read ${GOALS}, then the ${pr.kind === 'plan' ? 'plan in the diff' : 'diff and its plan entry'} (\`git diff origin/HEAD...HEAD\`).
Return the verdict, a short summary, one row per entry, and the escalation (for escalate).

${prBlock(pr)}`

const qaPrompt = (pr, round, last) => `${CONTEXT}

Task: try the change on the branch like a user, and check it does what the plan entry and the docs say.
Clone it: ${cloneTo(`qa-${pr.id}-r${round}`, pr)}. Install with \`${FAST_CHECKS[0]}\`. The diff is \`git diff origin/HEAD...HEAD\`.
What to try: ${typeof pr.qa === 'string' ? pr.qa : "the plan entry's QA line, if it has one, and its Acceptance line"}. Then add your own cases.
Return headSha, a summary, every scenario you ran, and the findings.

${prBlock(pr)}
${last ? `\nYour findings from the last round (check each is really fixed):\n${JSON.stringify(last, null, 1)}` : ''}`

const archPrompt = (pr, round) => `${CONTEXT}

Task: review the branch for architecture against ${ARCH}.
Clone it: ${cloneTo(`arch-${pr.id}-r${round}`, pr)}. The diff is \`git diff origin/HEAD...HEAD\`.
Return the verdict, a short summary, the new concepts, the findings (for needs-change) and the escalation (for escalate).

${prBlock(pr)}`

const fixPrompt = (pr, test, findings, round) => `${CONTEXT}

Task: fix the branch after review round ${round}.
1. You are in a fresh git worktree. ${freshBranch('fix', pr, round)}
2. Checks: ${fastText}, and ${ownE2e}.
Return a short summary of each fix, and any finding you disagree with and why.

${prBlock(pr)}

Failing checks:
${JSON.stringify((test && test.checks || []).filter(c => !c.pass), null, 1)}
Findings:
${JSON.stringify(findings, null, 1)}`

const docsWhere = A.docs && A.docs.length
  ? `The docs of this repo are: ${A.docs.join(', ')}.`
  : 'Find the docs yourself: README files, markdown under docs/ or similar, and a docs site if there is one (its source folder, for example docs/, site/ or website/, or HTML pages).'
const docsPrompt = (pr, signedSha) => `${CONTEXT}

Task: bring the docs in line with this PR. The code passed review at ${signedSha || 'the branch head'}.
1. You are in a fresh git worktree. ${freshBranch('docs', pr, 0)}
2. ${docsWhere}
3. ${A.docsBuild ? `Build the docs site with \`${A.docsBuild}\`.` : 'If the repo has a docs site build command, run it.'} Checks: ${fastText}.
Return changed, headSha (\`git rev-parse HEAD\` after your push), the files you changed, a short summary, and notes.

${prBlock(pr)}`

const docsFixPrompt = (pr, test, findings, round, signedSha) => `${CONTEXT}

Task: fix the docs after docs check round ${round}. Change docs only.
1. You are in a fresh git worktree. ${freshBranch('docsfix', pr, round)}
2. If \`git diff --stat ${signedSha || 'origin/HEAD'}..HEAD\` shows changes to code or tests, revert those parts: the code passed review at ${signedSha || 'the branch head'} and must stay as it was.
3. Fix each finding and failing check below in the docs. If a finding says the code is wrong and the docs are right, do not change the code: say so in notes.
4. Checks: ${fastText}.
Return changed, headSha (\`git rev-parse HEAD\` after your push), the files you changed, a short summary, and notes.

${prBlock(pr)}

Failing checks:
${JSON.stringify((test && test.checks || []).filter(c => !c.pass), null, 1)}
Findings:
${JSON.stringify(findings, null, 1)}`

const docsReviewPrompt = (pr, round, signedSha, docs) => `${CONTEXT}

Task: check the docs commits on the branch.
Clone it: ${cloneTo(`docsreview-${pr.id}-r${round}`, pr)}. The docs changes are \`git diff ${signedSha || 'origin/HEAD'}..HEAD\`; the code they describe is \`git diff origin/HEAD...HEAD\`.
Return headSha, a summary and the findings.

${prBlock(pr)}

Docs agent summary: ${JSON.stringify(docs)}`

const openPrompt = (pr, rounds, minors, arch) => `${CONTEXT}

Task: open the pull request for ${pr.branch} and file the minor findings.
1. Issues: \`gh issue create -R ${REPO} --label ${LABEL}${MILESTONE}\`. Body ends with "Found in review of ${pr.id}."
2. PR: \`gh pr create -R ${REPO} --head ${pr.branch}\`, title "${pr.title}". Include "Review: no blockers or majors after round N." (N from the history).
Return prNumber, prUrl and the issues you created.

${prBlock(pr)}

Review history: ${JSON.stringify(rounds)}
Architecture, product and docs: ${JSON.stringify(arch || [])}
Minor findings: ${JSON.stringify(minors, null, 1)}`

const waitPrompt = (pr, n) => `Task: wait for the review bots on pull request #${n} in ${REPO}, for at most ${BOT_WAIT_MIN} minutes.
Bots: ${BOTS}.
Poll with \`gh pr view ${n} -R ${REPO} --json reviews\` and \`gh pr checks ${n} -R ${REPO}\`. Inline threads: \`gh api repos/${REPO}/pulls/${n}/comments\`.
Return approvedBy (bot logins with an APPROVED review), openComments, timedOut, and one line of notes.`

const answerPrompt = (pr, n) => `${CONTEXT}

Task: answer the review bots on pull request #${n}.
1. You are in a fresh git worktree. ${freshBranch('bots', pr, 0)}
2. Reply on a thread with \`gh api repos/${REPO}/pulls/${n}/comments/<id>/replies -f body=...\`.
3. Checks if you changed code: ${fastText}, and ${ownE2e}.
Return threads addressed, whether code changed, substantiveChange, headSha (\`git rev-parse HEAD\` after your last push), and notes.

${prBlock(pr)}`

const landFixPrompt = pr => `${CONTEXT}

Task: bring PR #${pr.prNumber} (${pr.branch}) to a mergeable state with green CI.
1. You are in a fresh git worktree. ${freshBranch('land', pr, 0)}
2. Conflict: \`git merge origin/HEAD\`, then ${fastText}, and ${ownE2e}.
3. CI: \`gh run view <run> -R ${REPO} --log-failed\`; rerun a flaky network failure with \`gh run rerun <run> --failed\`.
4. Wait: \`gh pr checks ${pr.prNumber} -R ${REPO} --watch --interval 30\`.
Return readyToMerge, headSha and notes.

${prBlock(pr)}`

const preflightPrompt = () => `Task: check the goals document ${GOALS} on the default branch of ${REPO}.
Read it with \`gh api repos/${REPO}/contents/${GOALS} --jq .content | base64 --decode\`. If that fails, the file does not exist.
Return ok, exists, the two counts, and missing: a short list of what is absent (for example "file", "Goals section", "Non-goals items").`

async function reviewLoop(pr, startRound, history, minors, archState) {
  const max = roundsFor(pr)
  for (let round = startRound; round < startRound + max; round++) {
    const wantArch = archRuns(pr) && (round === startRound || archState.last === 'needs-change')
    const wantProduct = productRuns(pr) && round === startRound
    const wantQa = qaRuns(pr) && (round === startRound || archState.qaOpen.length > 0)
    const [test, review, arch, product, qa] = await parallel([
      () => call('test', pr, testPrompt(pr, round), `test:${pr.id}#${round}`, { schema: TEST }),
      () => call('review', pr, reviewPrompt(pr, round, history), `review:${pr.id}#${round}`, { schema: REVIEW }),
      () => wantArch ? call('arch', pr, archPrompt(pr, round), `arch:${pr.id}#${round}`, { schema: ARCHREV }) : Promise.resolve(null),
      () => wantProduct ? call('product', pr, productPrompt(pr, round), `product:${pr.id}#${round}`, { schema: PRODUCT }) : Promise.resolve(null),
      () => wantQa ? call('qa', pr, qaPrompt(pr, round, archState.qaOpen), `qa:${pr.id}#${round}`, { schema: QA }) : Promise.resolve(null),
    ])
    if (!test || !review) return { signedOff: false, reason: 'tester or reviewer failed' }
    if (wantArch && !arch) return { signedOff: false, reason: 'architecture reviewer failed' }
    if (wantProduct && !product) return { signedOff: false, reason: 'product reviewer failed' }
    if (wantQa && !qa) return { signedOff: false, reason: 'QA agent failed' }
    if (product) {
      archState.product = { round, verdict: product.verdict, summary: product.summary, entries: product.entries }
      log(`${pr.id} round ${round}: product ${product.verdict}`)
      if (product.verdict === 'notes') {
        minors.push(...product.entries.filter(e => e.fit !== 'serves-goal' && e.fit !== 'neutral')
          .map(e => ({ severity: 'minor', title: `Product fit: ${e.entry} (${e.fit})`, detail: `${e.note || ''} Suggestion: ${e.suggestion || 'keep'}.` })))
      }
    }
    if (arch) {
      archState.last = arch.verdict
      archState.reports.push({ round, verdict: arch.verdict, summary: arch.summary, newConcepts: arch.newConcepts })
      log(`${pr.id} round ${round}: architecture ${arch.verdict}`)
    }
    if (product && product.verdict === 'escalate') return { signedOff: false, reason: 'needs human: product', escalation: product.escalation }
    if (arch && arch.verdict === 'escalate') return { signedOff: false, reason: 'needs human: architecture', escalation: arch.escalation }
    const archFindings = arch && arch.verdict === 'needs-change'
      ? ((arch.findings && arch.findings.length) ? arch.findings : [{ title: 'Architecture review asked for changes', detail: arch.summary }])
          .map(f => Object.assign({ severity: 'major', source: 'architecture' }, f))
      : []
    const qaFindings = qa ? qa.findings.map(f => Object.assign({ source: 'qa' }, f)) : []
    if (qa) {
      archState.qaOpen = qaFindings.filter(f => f.severity !== 'minor')
      archState.qa.push({ round, summary: qa.summary, scenarios: qa.scenarios.length, failed: qa.scenarios.filter(s => !s.pass).map(s => s.name) })
      log(`${pr.id} round ${round}: QA ${qa.scenarios.length} scenarios, ${archState.qaOpen.length} blockers/majors`)
    }
    const blocking = review.findings.filter(f => f.severity !== 'minor').concat(archFindings, archState.qaOpen)
    minors.push(...review.findings.filter(f => f.severity === 'minor'), ...qaFindings.filter(f => f.severity === 'minor'))
    history.push({ round, testPass: test.pass, failingChecks: test.checks.filter(c => !c.pass).map(c => c.name), blockersAndMajors: blocking.map(f => `${f.severity}: ${f.title}`) })
    log(`${pr.id} round ${round}: tests ${test.pass ? 'pass' : 'fail'}, ${blocking.length} blockers/majors`)
    if (test.pass && blocking.length === 0) return { signedOff: true, headSha: test.headSha || review.headSha }
    if (round === startRound + max - 1) return { signedOff: false, reason: 'rounds exhausted', lastFindings: blocking, lastTest: test }
    await call('fix', pr, fixPrompt(pr, test, blocking, round), `fix:${pr.id}#${round}`)
  }
}

async function docsStep(pr, signedSha, history, minors) {
  const docs = await call('docs', pr, docsPrompt(pr, signedSha), `docs:${pr.id}`, { schema: DOCS })
  if (!docs) return { ok: false, reason: 'docs agent failed' }
  log(`${pr.id} docs: ${docs.changed ? (docs.files || []).join(', ') : 'no change'}`)
  if (!docs.changed) return { ok: true, headSha: signedSha, docs }
  for (let round = 1; round <= DOCS_ROUNDS; round++) {
    const [test, review] = await parallel([
      () => call('test', pr, testPrompt(pr, `docs${round}`), `test:${pr.id}#docs${round}`, { phase: 'Docs', schema: TEST }),
      () => call('docsReview', pr, docsReviewPrompt(pr, round, signedSha, docs), `docsreview:${pr.id}#${round}`, { schema: REVIEW }),
    ])
    if (!test || !review) return { ok: false, reason: 'docs check failed to run', docs }
    const blocking = review.findings.filter(f => f.severity !== 'minor')
    minors.push(...review.findings.filter(f => f.severity === 'minor'))
    history.push({ round: `docs${round}`, testPass: test.pass, failingChecks: test.checks.filter(c => !c.pass).map(c => c.name), blockersAndMajors: blocking.map(f => `${f.severity}: ${f.title}`) })
    log(`${pr.id} docs round ${round}: tests ${test.pass ? 'pass' : 'fail'}, ${blocking.length} blockers/majors`)
    if (test.pass && blocking.length === 0) return { ok: true, headSha: test.headSha || review.headSha, docs }
    if (round === DOCS_ROUNDS) return { ok: false, reason: 'docs check: rounds exhausted', lastFindings: blocking, docs }
    await call('docs', pr, docsFixPrompt(pr, test, blocking, round, signedSha), `docsfix:${pr.id}#${round}`, { schema: DOCS })
  }
}

async function bots(pr, n, headSha) {
  const wait = await call('botWait', pr, waitPrompt(pr, n), `botwait:${pr.id}`, { schema: WAIT })
  if (!wait) return { ok: false, reason: 'bot wait failed', headSha }
  if (!(wait.openComments > 0)) return { ok: true, headSha, wait }
  const answer = await call('botAnswer', pr, answerPrompt(pr, n), `botanswer:${pr.id}`, { schema: ANSWER })
  if (!answer) return { ok: false, reason: 'bot answer failed', headSha, wait }
  return { ok: true, headSha: answer.codeChanged && answer.headSha ? answer.headSha : headSha, wait, answer }
}

async function runPR(pr) {
  if (pr.landFix) {
    const n = pr.prNumber
    const r = await call('landFix', pr, landFixPrompt(pr), `landfix:${pr.id}`, { schema: LANDFIX })
    if (!r || !r.readyToMerge) return { id: pr.id, prNumber: n, ready: false, reason: 'land fix not ready', headSha: r && r.headSha, notes: r && r.notes }
    const b = await bots(pr, n, r.headSha)
    if (!b.ok) return { id: pr.id, prNumber: n, ready: false, reason: b.reason, headSha: b.headSha, notes: r.notes }
    let headSha = b.headSha
    const history = []
    if (b.answer && b.answer.substantiveChange) {
      const loop = await reviewLoop(pr, 1, history, [], { last: null, reports: [], product: null, qa: [], qaOpen: [] })
      if (!loop.signedOff) return { id: pr.id, prNumber: n, ready: false, reason: `after bots: ${loop.reason}`, history, lastFindings: loop.lastFindings, escalation: loop.escalation }
      headSha = loop.headSha
    }
    return {
      id: pr.id, prNumber: n, ready: true, headSha, land: `${n}:${headSha}`, notes: r.notes,
      approvedBy: b.wait.approvedBy || [], botNotes: b.wait.notes, codeChangedByBots: !!(b.answer && b.answer.codeChanged), history,
    }
  }
  const history = pr.resume ? pr.resume.history || [] : []
  const minors = pr.resume ? pr.resume.minors || [] : []
  let impl = { problems: '' }
  if (pr.resume && (pr.resume.findings || []).length) {
    await call('fix', pr, fixPrompt(pr, null, pr.resume.findings, history.length), `fix:${pr.id}#${history.length}`)
  } else if (!pr.skipImpl && !pr.resume) {
    impl = await call('impl', pr, implPrompt(pr), `implement:${pr.id}`, { schema: IMPL })
    if (!impl || !impl.pushed) return { id: pr.id, ready: false, reason: 'implementation not pushed', impl }
  }
  const archState = { last: null, reports: [], product: null, qa: [], qaOpen: [] }
  let loop = await reviewLoop(pr, history.length + 1, history, minors, archState)
  if (!loop.signedOff) return { id: pr.id, ready: false, reason: loop.reason, history, lastFindings: loop.lastFindings, escalation: loop.escalation, architecture: archState.reports, product: archState.product }

  let docs = null
  if (docsRuns(pr)) {
    const d = await docsStep(pr, loop.headSha, history, minors)
    if (!d.ok) return { id: pr.id, ready: false, reason: d.reason, history, lastFindings: d.lastFindings, docs: d.docs, architecture: archState.reports, product: archState.product }
    loop.headSha = d.headSha
    docs = { changed: d.docs.changed, files: d.docs.files || [], summary: d.docs.summary }
  }

  const opened = await call('open', pr, openPrompt(pr, history, minors, { architecture: archState.reports, product: archState.product, docs }), `open:${pr.id}`, { schema: OPEN })
  if (!opened || !opened.prNumber) return { id: pr.id, ready: false, reason: 'PR not opened', history }
  const n = opened.prNumber

  const b = await bots(pr, n, loop.headSha)
  if (!b.ok) return { id: pr.id, ready: false, reason: b.reason, history, prNumber: n, headSha: b.headSha }
  const { wait, answer } = b
  let headSha = b.headSha
  if (answer && answer.substantiveChange) {
    loop = await reviewLoop(pr, history.length + 1, history, minors, archState)
    if (!loop.signedOff) return { id: pr.id, ready: false, reason: `after bots: ${loop.reason}`, history, prNumber: n, lastFindings: loop.lastFindings, escalation: loop.escalation, architecture: archState.reports, product: archState.product }
    headSha = loop.headSha
  }
  return {
    id: pr.id, ready: true, prNumber: n, prUrl: opened.prUrl, headSha,
    land: `${n}:${headSha}`,
    approvedBy: (wait && wait.approvedBy) || [], botNotes: wait && wait.notes,
    codeChangedByBots: !!(answer && answer.codeChanged),
    docs,
    issues: opened.issuesCreated || [], rounds: history.length, history, architecture: archState.reports, product: archState.product, qa: archState.qa, implProblems: impl.problems || '',
  }
}

const needsGoals = A.prs.some(pr => !pr.landFix)
if (needsGoals) {
  const pre = await call('preflight', null, preflightPrompt(), 'preflight:goals', { schema: PREFLIGHT })
  if (!pre || !pre.ok) {
    const missing = pre ? pre.missing.join(', ') : 'the preflight agent did not answer'
    log(`refused: ${GOALS} is missing or incomplete (${missing})`)
    return A.prs.map(pr => ({ id: pr.id, ready: false, refused: true, reason: `goals document missing or incomplete: ${missing}. Write ${GOALS} with the write-goals skill (or from templates/goals.md) and run again.` }))
  }
}
return await parallel(A.prs.map(pr => () => runPR(pr)))
