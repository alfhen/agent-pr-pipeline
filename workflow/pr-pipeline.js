export const meta = {
  name: 'agent-pr-pipeline',
  description: 'Build, test, review and fix one wave of PRs, open them and answer the review bots; each step a separate agent',
  phases: [
    { title: 'Implement', detail: 'one agent builds each PR on its own branch' },
    { title: 'Test', detail: 'a second agent runs the fast checks and the PR\'s own e2e from a clean clone' },
    { title: 'Review', detail: 'a stronger model reviews the diff adversarially' },
    { title: 'Architecture', detail: 'a stronger model checks the PR against the architecture, and asks a person when the architecture itself should change' },
    { title: 'Fix', detail: 'an agent fixes blockers, majors and failing checks' },
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
  reviewDocs: { model: 'sonnet', effort: 'high' },
  fix: { model: 'sonnet', effort: 'medium' },
  open: { model: 'sonnet', effort: 'low' },
  botWait: { model: 'haiku', effort: 'low' },
  botAnswer: { model: 'sonnet', effort: 'medium' },
  landFix: { model: 'sonnet', effort: 'medium' },
}, A.steps || {})
if (!REPO || !TMP || !PLAN || !Array.isArray(A.prs)) throw new Error('args needs repo, tmp, plan and prs')

const roundsFor = pr => pr.maxRounds || (pr.kind === 'plan' ? (A.planRounds || 2) : (A.maxRounds || 4))
const reviewStep = pr => (pr.kind === 'plan' || pr.kind === 'docs') ? STEPS.reviewDocs : STEPS.review
const archRuns = pr => pr.kind !== 'docs' && !!ARCH && A.architectureReview !== false
const decided = pr => pr.architectureDecision ? `\nArchitecture decision by the maintainer for this PR (settled; follow it): ${pr.architectureDecision}` : ''
const opts = (step, extra) => Object.assign({ model: step.model, effort: step.effort }, extra)

const CONTEXT = `You are working on ${REPO} (https://github.com/${REPO}).
${SPEC ? `The spec is ${SPEC}. ` : ''}The current plan is ${PLAN}. The plan entry for your PR (its section, with its Touches and Acceptance lines) is your brief, plus the notes below. The plan's "Rules for every PR" section applies, and so do AGENTS.md or CLAUDE.md in the repo.

${A.context || ''}

Working rules:
- Temporary files go under ${TMP}/<your label>/. Never use /tmp.
- Git: never push to the default branch, never force-push, never merge, never tag, never publish a package, never create a release, unless your task says so. Push only the feature branch named in your task.
- Stay in the scope of your PR. Do not build later PRs.
- Commit messages, docs and PR text: plain, short sentences.
- Code comments only for why, hidden constraints, or properties a refactor must keep.
- Match the style of the code around you.`

const fastText = FAST_CHECKS.map(c => `\`${c}\``).join(', ')
const ownE2e = `the e2e test files this branch adds or changes (\`git diff --name-only origin/HEAD...HEAD | grep -E '${E2E_PATTERN}'\`), run with \`${E2E_COMMAND}\` where {files} is that list; skip this when the list is empty. The full e2e suite is CI's job: do not run it`
const prBlock = pr => `PR: ${pr.id} - ${pr.title}\nBranch: ${pr.branch}\nKind: ${pr.kind || 'code'}\nNotes for this PR:\n${pr.notes || '(none)'}${decided(pr)}`

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
  properties: { threadsAddressed: { type: 'number' }, codeChanged: { type: 'boolean' }, substantiveChange: { type: 'boolean' }, notes: { type: 'string' } },
  required: ['codeChanged', 'substantiveChange'],
}
const LANDFIX = {
  type: 'object',
  properties: { readyToMerge: { type: 'boolean' }, headSha: { type: 'string' }, notes: { type: 'string' } },
  required: ['readyToMerge', 'notes'],
}

const freshBranch = (prefix, pr, n) => `\`git fetch origin && git checkout -B ${prefix}-${pr.id}-r${n} origin/${pr.branch}\` (a new local name, because another worktree may hold ${pr.branch}). Push with \`git push origin HEAD:${pr.branch}\`. Never force-push.`

const implPrompt = pr => `${CONTEXT}

${prBlock(pr)}

Your job: implement this PR.
1. You are in a fresh git worktree. Run \`git fetch origin && git checkout -B ${pr.branch} origin/HEAD\`. If ${pr.branch} already exists on origin from an earlier attempt, build on it instead: \`git checkout -B ${pr.branch} origin/${pr.branch}\`.
2. Read ${SPEC ? `${SPEC} and ` : ''}${PLAN} and the code you will change.
3. Build the PR with unit tests and the test named in its Acceptance line. Keep it small and in scope.
4. Run ${fastText}, and ${ownE2e}. Make sure the acceptance test fails for the right reason: break the feature locally, see the test fail, restore it.
5. Commit and \`git push -u origin ${pr.branch}\`. Do not open a PR.
Return pushed, branch, headSha, a short summary, whether the acceptance test passed, and any problems or open questions.`

const testPrompt = (pr, round) => `${CONTEXT}

${prBlock(pr)}

Your job: test branch ${pr.branch} from a clean clone. Do not change code.
1. \`rm -rf ${TMP}/test-${pr.id}-r${round} && git clone --branch ${pr.branch} https://github.com/${REPO}.git ${TMP}/test-${pr.id}-r${round}\` and cd there.
2. Run in order and capture output: ${fastText}. Then run ${ownE2e}. Run every step even if an earlier one fails, when possible.
3. Check that the acceptance test from the plan exists and ran (was not skipped).
4. Delete the clone when done.
Return pass (true only if every step passed), headSha, and one entry per check with the failing log excerpt (the relevant 40 lines).`

const reviewPrompt = (pr, round, history) => `${CONTEXT}

${prBlock(pr)}

Your job: review branch ${pr.branch} adversarially against ${SPEC ? `${SPEC} and ` : ''}${PLAN}. Do not change code or push anything.
Clone it: \`rm -rf ${TMP}/review-${pr.id}-r${round} && git clone https://github.com/${REPO}.git ${TMP}/review-${pr.id}-r${round} && cd ${TMP}/review-${pr.id}-r${round} && git checkout ${pr.branch}\`. Read the full diff (\`git diff origin/HEAD...HEAD\`) and the touched files in full. You may run single tests to check a suspicion.
Look for: correctness bugs and drift from the spec and the plan entry; security and privacy problems; scope creep; tests that pass for the wrong reason (assertions that cannot fail, skipped tests, mocks that hide the behaviour, timing that makes a test vacuous); broken project rules; claims the PR makes without evidence.
Rank each finding: blocker (wrong, unsafe, or the acceptance test does not prove the feature), major (must fix before merge), minor (fine as a follow-up issue). Be concrete: file, what is wrong, how to fix. No style nits. Default to no finding when unsure.${pr.kind === 'plan' ? ' This is a plan document: anything an implementer can settle without changing the plan\'s intent is minor.' : ''}
${history.length ? `Earlier rounds (check their blockers and majors are really fixed):\n${JSON.stringify(history, null, 1)}` : ''}
Delete the clone when done. Return headSha, a summary and the findings.`

const archPrompt = (pr, round) => `${CONTEXT}

${prBlock(pr)}

Your job: review branch ${pr.branch} for architecture. You are not looking for bugs; another reviewer does that. Do not change code or push anything.
Clone it: \`rm -rf ${TMP}/arch-${pr.id}-r${round} && git clone https://github.com/${REPO}.git ${TMP}/arch-${pr.id}-r${round} && cd ${TMP}/arch-${pr.id}-r${round} && git checkout ${pr.branch}\`. Read ${ARCH} (the architecture), ${PLAN} (the plan entry and its neighbours), the full diff (\`git diff origin/HEAD...HEAD\`) and enough of the code around it to see the existing structure.
1. List every new concept the PR introduces: a new module or package, a new record type or field, a new step, flag, command or config file, a new dependency, a new process or network boundary, a new place where state lives. For each, say where it is and whether it fits the architecture as written.
2. Decide one verdict:
   - fits: the PR stays inside the architecture, or extends it the way the architecture already expects.
   - needs-change: the PR goes against the architecture in a way this PR can fix (wrong layer, a duplicate concept, a dependency in the wrong direction, a rule from the architecture doc broken). Give concrete findings with a suggested fix.
   - escalate: the architecture itself should change, because this PR (or the plan around it) shows that the current structure will not hold well for the planned or likely next changes, or because the PR needs a decision that is not this PR's to make. Do not escalate for something a fix can settle. Write the question for the maintainer, 2 to 4 options, your recommendation and why.
${pr.architectureDecision ? 'The maintainer already decided the architecture question for this PR (see above). Do not escalate it again; check the PR follows the decision.' : ''}
Delete the clone when done. Return the verdict, a short summary, the new concepts, the findings (for needs-change) and the escalation (for escalate).`

const fixPrompt = (pr, test, findings, round) => `${CONTEXT}

${prBlock(pr)}

Your job: fix branch ${pr.branch} after review round ${round}.
1. You are in a fresh git worktree. ${freshBranch('fix', pr, round)}
2. Fix every blocker and major below, and every failing check. If you think a finding is wrong, do not ignore it: fix it, or explain why with evidence in your answer.
3. Run ${fastText}, and ${ownE2e}.
4. Commit and push with \`git push origin HEAD:${pr.branch}\`.
Failing checks:
${JSON.stringify((test && test.checks || []).filter(c => !c.pass), null, 1)}
Findings:
${JSON.stringify(findings, null, 1)}
Return a short summary of each fix, and any finding you disagree with and why.`

const openPrompt = (pr, rounds, minors, arch) => `${CONTEXT}

${prBlock(pr)}

Your job: open the pull request for ${pr.branch} and file minor findings. Do not change code.
1. File each minor finding below as a GitHub issue with label ${LABEL} (\`gh issue create -R ${REPO} --label ${LABEL}${MILESTONE}\`). Skip duplicates of each other and of open issues. Body: the finding, the file, and "Found in review of ${pr.id}."
2. Open a ready PR to the default branch if none exists: \`gh pr create -R ${REPO} --head ${pr.branch}\`, title "${pr.title}". Body: what it does, how it is tested, "Review: no blockers or majors after round N." (N from the history), one line with the architecture verdict and the new concepts if the history has them, links to the issues you filed, and each \`Closes #N\` on its own line.
Review history: ${JSON.stringify(rounds)}
Architecture review: ${JSON.stringify(arch || [])}
Minor findings: ${JSON.stringify(minors, null, 1)}
Return prNumber, prUrl and the issues you created.`

const waitPrompt = (pr, n) => `Wait for the review bots on pull request #${n} in ${REPO}. Do not change anything, comment, or push.
Bots: ${BOTS}.
Every 60 seconds, for at most ${BOT_WAIT_MIN} minutes, run \`gh pr view ${n} -R ${REPO} --json reviews\` and \`gh pr checks ${n} -R ${REPO}\`. Stop early when a bot has an APPROVED review and its check has finished, or when every bot has finished (a review, or a comment saying it is done, skipped or rate-limited).
Then count the open bot comments: inline threads (\`gh api repos/${REPO}/pulls/${n}/comments\`) by a bot login with no reply yet, plus actionable items in a bot review body.
Return approvedBy (bot logins with an APPROVED review), openComments (that count), timedOut, and one line of notes.`

const answerPrompt = (pr, n) => `${CONTEXT}

${prBlock(pr)}

Your job: answer the review bots on pull request #${n}.
1. You are in a fresh git worktree. ${freshBranch('bots', pr, 0)}
2. For each bot comment without a reply: decide if it is right. If right, fix it. Reply on the thread (\`gh api repos/${REPO}/pulls/${n}/comments/<id>/replies -f body=...\`) in one or two sentences: what you changed, or why not. Answer review-body items in one PR comment per bot.
3. If you changed code, run ${fastText}, and ${ownE2e}; commit and push.
Set substantiveChange true if your changes alter behaviour beyond small fixes.
Return threads addressed, whether code changed, substantiveChange, and notes.`

const landFixPrompt = pr => `${CONTEXT}

${prBlock(pr)}

Your job: bring PR #${pr.prNumber} (${pr.branch}) to a mergeable state with green CI. Do not merge it.
1. You are in a fresh git worktree. ${freshBranch('land', pr, 0)}
2. If the PR conflicts: \`git merge origin/HEAD\`, resolve keeping both sides' intent (lockfiles: take the default branch's version and reinstall), run ${fastText}, and ${ownE2e}, commit and push.
3. If a CI job failed: read the log (\`gh run view <run> -R ${REPO} --log-failed\`), fix small causes, push. Rerun a flaky network failure once with \`gh run rerun <run> --failed\`.
4. Wait for CI on the new head (\`gh pr checks ${pr.prNumber} -R ${REPO} --watch --interval 30\`). Stop when it is MERGEABLE and green, or after 3 attempts.
Return readyToMerge, headSha and notes.`

async function reviewLoop(pr, startRound, history, minors, archState) {
  const max = roundsFor(pr)
  for (let round = startRound; round < startRound + max; round++) {
    const wantArch = archRuns(pr) && (round === startRound || archState.last === 'needs-change')
    const [test, review, arch] = await parallel([
      () => agent(testPrompt(pr, round), opts(STEPS.test, { label: `test:${pr.id}#${round}`, phase: 'Test', schema: TEST })),
      () => agent(reviewPrompt(pr, round, history), opts(reviewStep(pr), { label: `review:${pr.id}#${round}`, phase: 'Review', schema: REVIEW })),
      () => wantArch ? agent(archPrompt(pr, round), opts(STEPS.arch, { label: `arch:${pr.id}#${round}`, phase: 'Architecture', schema: ARCHREV })) : Promise.resolve(null),
    ])
    if (!test || !review) return { signedOff: false, reason: 'tester or reviewer failed' }
    if (wantArch && !arch) return { signedOff: false, reason: 'architecture reviewer failed' }
    if (arch) {
      archState.last = arch.verdict
      archState.reports.push({ round, verdict: arch.verdict, summary: arch.summary, newConcepts: arch.newConcepts })
      log(`${pr.id} round ${round}: architecture ${arch.verdict}`)
      if (arch.verdict === 'escalate') return { signedOff: false, reason: 'needs human: architecture', escalation: arch.escalation, architecture: arch }
    }
    const archFindings = arch && arch.verdict === 'needs-change'
      ? (arch.findings || []).map(f => Object.assign({ severity: 'major', source: 'architecture' }, f))
      : []
    const blocking = review.findings.filter(f => f.severity !== 'minor').concat(archFindings)
    minors.push(...review.findings.filter(f => f.severity === 'minor'))
    history.push({ round, testPass: test.pass, failingChecks: test.checks.filter(c => !c.pass).map(c => c.name), blockersAndMajors: blocking.map(f => `${f.severity}: ${f.title}`) })
    log(`${pr.id} round ${round}: tests ${test.pass ? 'pass' : 'fail'}, ${blocking.length} blockers/majors`)
    if (test.pass && blocking.length === 0) return { signedOff: true }
    if (round === startRound + max - 1) return { signedOff: false, reason: 'rounds exhausted', lastFindings: blocking, lastTest: test }
    await agent(fixPrompt(pr, test, blocking, round), opts(STEPS.fix, { label: `fix:${pr.id}#${round}`, phase: 'Fix', isolation: 'worktree' }))
  }
}

async function runPR(pr) {
  if (pr.landFix) {
    const r = await agent(landFixPrompt(pr), opts(STEPS.landFix, { label: `landfix:${pr.id}`, phase: 'Land fix', isolation: 'worktree', schema: LANDFIX }))
    return { id: pr.id, prNumber: pr.prNumber, ready: !!(r && r.readyToMerge), headSha: r && r.headSha, notes: r && r.notes }
  }
  const history = pr.resume ? pr.resume.history || [] : []
  const minors = pr.resume ? pr.resume.minors || [] : []
  let impl = { problems: '' }
  if (pr.resume && (pr.resume.findings || []).length) {
    await agent(fixPrompt(pr, null, pr.resume.findings, history.length), opts(STEPS.fix, { label: `fix:${pr.id}#${history.length}`, phase: 'Fix', isolation: 'worktree' }))
  } else if (!pr.skipImpl && !pr.resume) {
    impl = await agent(implPrompt(pr), opts(STEPS.impl, { label: `implement:${pr.id}`, phase: 'Implement', isolation: 'worktree', schema: IMPL }))
    if (!impl || !impl.pushed) return { id: pr.id, ready: false, reason: 'implementation not pushed', impl }
  }
  const archState = { last: null, reports: [] }
  let loop = await reviewLoop(pr, history.length + 1, history, minors, archState)
  if (!loop.signedOff) return { id: pr.id, ready: false, reason: loop.reason, history, lastFindings: loop.lastFindings, escalation: loop.escalation, architecture: archState.reports }

  const opened = await agent(openPrompt(pr, history, minors, archState.reports), opts(STEPS.open, { label: `open:${pr.id}`, phase: 'Open PR', schema: OPEN }))
  if (!opened || !opened.prNumber) return { id: pr.id, ready: false, reason: 'PR not opened', history }
  const n = opened.prNumber

  const wait = await agent(waitPrompt(pr, n), opts(STEPS.botWait, { label: `botwait:${pr.id}`, phase: 'Bots', schema: WAIT }))
  let answer = null
  if (wait && wait.openComments > 0) {
    answer = await agent(answerPrompt(pr, n), opts(STEPS.botAnswer, { label: `botanswer:${pr.id}`, phase: 'Bots', isolation: 'worktree', schema: ANSWER }))
    if (answer && answer.substantiveChange) {
      loop = await reviewLoop(pr, history.length + 1, history, minors, archState)
      if (!loop.signedOff) return { id: pr.id, ready: false, reason: `after bots: ${loop.reason}`, history, prNumber: n }
    }
  }
  return {
    id: pr.id, ready: true, prNumber: n, prUrl: opened.prUrl,
    approvedBy: (wait && wait.approvedBy) || [], botNotes: wait && wait.notes,
    codeChangedByBots: !!(answer && answer.codeChanged),
    issues: opened.issuesCreated || [], rounds: history.length, history, architecture: archState.reports, implProblems: impl.problems || '',
  }
}

return await parallel(A.prs.map(pr => () => runPR(pr)))
