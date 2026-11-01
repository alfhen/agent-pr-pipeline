export const meta = {
  name: 'agent-pr-pipeline',
  description: 'Build, test, review, fix and ready one wave of PRs, each step a separate agent',
  phases: [
    { title: 'Implement', detail: 'one agent builds each PR on its own branch' },
    { title: 'Test', detail: 'a second agent runs every check from a clean clone' },
    { title: 'Review', detail: 'a stronger model reviews the diff adversarially' },
    { title: 'Fix', detail: 'an agent fixes blockers, majors and failing checks' },
    { title: 'Bots', detail: 'open the PR, file minors as issues, answer the review bots' },
    { title: 'Land', detail: 'bring the PR to mergeable with green CI; the main session merges' },
  ],
}

// args: see SKILL.md, "Workflow arguments".
const A = args || {}
const REPO = A.repo
const TMP = A.tmp
const PLAN = A.plan
const SPEC = A.spec || ''
const MAX_ROUNDS = A.maxRounds || 4
const CHECKS = A.checks || ['pnpm install --frozen-lockfile', 'pnpm lint', 'pnpm typecheck', 'pnpm test']
const MODELS = Object.assign({ impl: 'sonnet', test: 'sonnet', review: 'opus', fix: 'sonnet', bots: 'sonnet', land: 'sonnet' }, A.models || {})
const BOTS = A.bots || 'CodeRabbit (login coderabbitai) and Gitar (login contains "gitar")'
const LABEL = A.minorLabel || 'review-minor'
const MILESTONE = A.milestone ? ` --milestone "${A.milestone}"` : ''
if (!REPO || !TMP || !PLAN || !Array.isArray(A.prs)) throw new Error('args needs repo, tmp, plan and prs')

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

const checksText = CHECKS.map(c => `\`${c}\``).join(', ')
const prBlock = pr => `PR: ${pr.id} - ${pr.title}\nBranch: ${pr.branch}\nNotes for this PR:\n${pr.notes || '(none)'}`

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
const BOTS_OUT = {
  type: 'object',
  properties: {
    prNumber: { type: 'number' }, prUrl: { type: 'string' },
    approvedBy: { type: 'array', items: { type: 'string' } },
    threadsAddressed: { type: 'number' }, codeChanged: { type: 'boolean' }, substantiveChange: { type: 'boolean' },
    issuesCreated: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' },
  },
  required: ['prNumber', 'codeChanged', 'substantiveChange'],
}
const LAND = {
  type: 'object',
  properties: { readyToMerge: { type: 'boolean' }, headSha: { type: 'string' }, ciPassed: { type: 'boolean' }, notes: { type: 'string' } },
  required: ['readyToMerge', 'notes'],
}

const freshBranch = (prefix, pr, n) => `\`git fetch origin && git checkout -B ${prefix}-${pr.id}-r${n} origin/${pr.branch}\` (a new local name, because another worktree may hold ${pr.branch}). Push with \`git push origin HEAD:${pr.branch}\`. Never force-push.`

const implPrompt = pr => `${CONTEXT}

${prBlock(pr)}

Your job: implement this PR.
1. You are in a fresh git worktree. Run \`git fetch origin && git checkout -B ${pr.branch} origin/HEAD\`. If ${pr.branch} already exists on origin from an earlier attempt, build on it instead: \`git checkout -B ${pr.branch} origin/${pr.branch}\`.
2. Read ${SPEC ? `${SPEC} and ` : ''}${PLAN} and the code you will change.
3. Build the PR with unit tests and the test named in its Acceptance line. Keep it small and in scope.
4. Run ${checksText} until they pass. Make sure the acceptance test fails for the right reason: break the feature locally, see the test fail, restore it.
5. Commit and \`git push -u origin ${pr.branch}\`. Do not open a PR.
Return pushed, branch, headSha, a short summary, whether the acceptance test passed, and any problems or open questions.`

const testPrompt = (pr, round) => `${CONTEXT}

${prBlock(pr)}

Your job: test branch ${pr.branch} from a clean clone. Do not change code.
1. \`rm -rf ${TMP}/test-${pr.id}-r${round} && git clone --branch ${pr.branch} https://github.com/${REPO}.git ${TMP}/test-${pr.id}-r${round}\` and cd there.
2. Run in order and capture output: ${checksText}. Run every step even if an earlier one fails, when possible.
3. Check that the acceptance test from the plan exists and ran (was not skipped).
4. Delete the clone when done.
Return pass (true only if every step passed), headSha, and one entry per check with the failing log excerpt (the relevant 40 lines).`

const reviewPrompt = (pr, round, history) => `${CONTEXT}

${prBlock(pr)}

Your job: review branch ${pr.branch} adversarially against ${SPEC ? `${SPEC} and ` : ''}${PLAN}. Do not change code or push anything.
Clone it: \`rm -rf ${TMP}/review-${pr.id}-r${round} && git clone https://github.com/${REPO}.git ${TMP}/review-${pr.id}-r${round} && cd ${TMP}/review-${pr.id}-r${round} && git checkout ${pr.branch}\`. Read the full diff (\`git diff origin/HEAD...HEAD\`) and the touched files in full. You may run tests to check a suspicion.
Look for: correctness bugs and drift from the spec and the plan entry; security and privacy problems; scope creep; tests that pass for the wrong reason (assertions that cannot fail, skipped tests, mocks that hide the behaviour, timing that makes a test vacuous); broken project rules; claims the PR makes without evidence.
Rank each finding: blocker (wrong, unsafe, or the acceptance test does not prove the feature), major (must fix before merge), minor (fine as a follow-up issue). Be concrete: file, what is wrong, how to fix. No style nits. Default to no finding when unsure.
${history.length ? `Earlier rounds (check their blockers and majors are really fixed):\n${JSON.stringify(history, null, 1)}` : ''}
Delete the clone when done. Return headSha, a summary and the findings.`

const fixPrompt = (pr, test, findings, round) => `${CONTEXT}

${prBlock(pr)}

Your job: fix branch ${pr.branch} after review round ${round}.
1. You are in a fresh git worktree. ${freshBranch('fix', pr, round)}
2. Fix every blocker and major below, and every failing check. If you think a finding is wrong, do not ignore it: fix it, or explain why with evidence in your answer.
3. Run ${checksText} until they pass.
4. Commit and push with \`git push origin HEAD:${pr.branch}\`.
Failing checks:
${JSON.stringify((test && test.checks || []).filter(c => !c.pass), null, 1)}
Findings:
${JSON.stringify(findings, null, 1)}
Return a short summary of each fix, and any finding you disagree with and why.`

const botsPrompt = (pr, rounds, minors) => `${CONTEXT}

${prBlock(pr)}

Your job: open the pull request for ${pr.branch}, file minor findings as issues, and answer the review bots.
1. You are in a fresh git worktree. ${freshBranch('bots', pr, 0)}
2. File each minor finding below as a GitHub issue with label ${LABEL}${MILESTONE ? ' and the milestone' : ''} (\`gh issue create --label ${LABEL}${MILESTONE}\`). Skip duplicates and ones the branch already fixed. Body: the finding, the file, and "Found in review of ${pr.id}."
3. Open a ready PR to the default branch if none exists: \`gh pr create --head ${pr.branch}\`, title "${pr.title}". Body: what it does, how it is tested, "Review: no blockers or majors after round N." (N from the history), links to the issues you filed, and each \`Closes #N\` on its own line.
4. Wait for the review bots: ${BOTS}. Poll every 60 s for up to 20 minutes (\`gh pr view <n> --json reviews,comments\`, \`gh api repos/${REPO}/pulls/<n>/comments\`, \`gh pr checks <n>\`). Stop when one bot approved, or all have finished, or after 20 minutes.
5. For every bot comment: decide if it is right. If right, fix it. Reply on the thread in one or two sentences saying what you changed or why not. Answer review-body items in one PR comment per bot.
6. If you changed code, run ${checksText}, commit and push.
Set substantiveChange true if your changes alter behaviour beyond small fixes.
Review history: ${JSON.stringify(rounds)}
Minor findings: ${JSON.stringify(minors, null, 1)}
Return the PR number and URL, approvedBy (bot logins that approved), threads addressed, whether code changed, issues created, and notes.`

const landPrompt = (pr, b) => `${CONTEXT}

${prBlock(pr)}

Your job: bring PR #${b.prNumber} (${pr.branch}) to a mergeable state with green CI. Do not merge it.
1. You are in a fresh git worktree. ${freshBranch('land', pr, 0)}
2. \`gh pr view ${b.prNumber} --json mergeable,mergeStateStatus\`. If CONFLICTING: \`git merge origin/HEAD\`, resolve the conflicts keeping both sides' intent (for lockfiles take the default branch's version and reinstall), run ${checksText}, commit and push. If MERGEABLE, do not touch the branch.
3. \`gh pr checks ${b.prNumber} --watch --interval 30\`. If a CI job fails, read the log, fix small causes, push, and wait again, up to 3 times. Rerun a flaky network failure once.
4. Stop when the PR is MERGEABLE and CI passes on its head. The main session merges.
Return readyToMerge, headSha, ciPassed and notes.`

async function reviewLoop(pr, startRound, history, minors) {
  for (let round = startRound; round < startRound + MAX_ROUNDS; round++) {
    const [test, review] = await parallel([
      () => agent(testPrompt(pr, round), { label: `test:${pr.id}#${round}`, phase: 'Test', model: MODELS.test, schema: TEST }),
      () => agent(reviewPrompt(pr, round, history), { label: `review:${pr.id}#${round}`, phase: 'Review', model: MODELS.review, effort: 'high', schema: REVIEW }),
    ])
    if (!test || !review) return { signedOff: false, reason: 'tester or reviewer failed' }
    const blocking = review.findings.filter(f => f.severity !== 'minor')
    minors.push(...review.findings.filter(f => f.severity === 'minor'))
    history.push({ round, testPass: test.pass, failingChecks: test.checks.filter(c => !c.pass).map(c => c.name), blockersAndMajors: blocking.map(f => `${f.severity}: ${f.title}`) })
    log(`${pr.id} round ${round}: tests ${test.pass ? 'pass' : 'fail'}, ${blocking.length} blockers/majors`)
    if (test.pass && blocking.length === 0) return { signedOff: true }
    if (round === startRound + MAX_ROUNDS - 1) return { signedOff: false, reason: 'rounds exhausted', lastFindings: blocking, lastTest: test }
    await agent(fixPrompt(pr, test, blocking, round), { label: `fix:${pr.id}#${round}`, phase: 'Fix', model: MODELS.fix, isolation: 'worktree' })
  }
}

async function runPR(pr) {
  const history = pr.resume ? pr.resume.history || [] : []
  const minors = pr.resume ? pr.resume.minors || [] : []
  let impl = { problems: '' }
  if (pr.resume && (pr.resume.findings || []).length) {
    await agent(fixPrompt(pr, null, pr.resume.findings, history.length), { label: `fix:${pr.id}#${history.length}`, phase: 'Fix', model: MODELS.fix, isolation: 'worktree' })
  } else if (!pr.skipImpl && !pr.resume) {
    impl = await agent(implPrompt(pr), { label: `implement:${pr.id}`, phase: 'Implement', model: MODELS.impl, isolation: 'worktree', schema: IMPL })
    if (!impl || !impl.pushed) return { id: pr.id, ready: false, reason: 'implementation not pushed', impl }
  }
  let loop = await reviewLoop(pr, history.length + 1, history, minors)
  if (!loop.signedOff) return { id: pr.id, ready: false, reason: loop.reason, history, lastFindings: loop.lastFindings }

  const b = await agent(botsPrompt(pr, history, minors), { label: `bots:${pr.id}`, phase: 'Bots', model: MODELS.bots, isolation: 'worktree', schema: BOTS_OUT })
  if (!b || !b.prNumber) return { id: pr.id, ready: false, reason: 'PR not opened', history }
  if (b.substantiveChange) {
    loop = await reviewLoop(pr, history.length + 1, history, minors)
    if (!loop.signedOff) return { id: pr.id, ready: false, reason: `after bots: ${loop.reason}`, history, prNumber: b.prNumber }
  }
  const land = await agent(landPrompt(pr, b), { label: `land:${pr.id}`, phase: 'Land', model: MODELS.land, isolation: 'worktree', schema: LAND })
  return {
    id: pr.id, ready: !!(land && land.readyToMerge), prNumber: b.prNumber, prUrl: b.prUrl,
    headSha: land && land.headSha, approvedBy: b.approvedBy || [], issues: b.issuesCreated || [],
    rounds: history.length, history, land, implProblems: impl.problems || '',
  }
}

return await parallel(A.prs.map(pr => () => runPR(pr)))
