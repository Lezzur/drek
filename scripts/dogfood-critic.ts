/**
 * Dogfood the M36 production-realism critic against a real-shaped brief.
 *
 *   npx tsx scripts/dogfood-critic.ts
 *
 * Constructs a deliberately-flawed build plan for the brief
 * "Claude API Developer to Build AI Email Reply Assistant (Gmail Integration)"
 * and runs it through critiquePlan() with the live Claude CLI provider.
 *
 * The plan below has several baked-in problems — see the inline comments.
 * The critic should catch some of these. Anything it misses is grist for
 * M37 criterion-tuning.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import {
  critiquePlan,
  buildCriticPrompt,
  type CritiqueResult,
  type CritiqueUnavailable,
} from '../src/engine/critique-plan.js';
import {
  CRITERIA_VERSION,
  getCriterion,
} from '../src/engine/critique-criteria.js';
import type { LLMProvider } from '../src/providers/types.js';
import type { TransformedBuildPlan } from '../src/db/schemas.js';

// Inline standalone provider: shells claude CLI directly. Skips DREK's
// env + Firestore dependency so this dogfood script can run anywhere
// claude is installed.
class StandaloneClaudeProvider implements LLMProvider {
  readonly name = 'claude' as const;
  async generate(prompt: string, opts?: { timeoutMs?: number }): Promise<string> {
    const model = process.env.CLAUDE_MODEL ?? 'claude-opus-4-7';
    return new Promise((resolve, reject) => {
      const proc = spawn('claude', ['-p', '--model', model], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`claude CLI timed out after ${opts?.timeoutMs ?? 120_000}ms`));
      }, opts?.timeoutMs ?? 120_000);
      proc.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
      proc.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`claude CLI exited ${code}: ${stderr}`));
      });
      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  }
}

const briefGoal =
  'Build a Claude-powered AI email reply assistant that drafts contextual ' +
  'replies inside the user\'s Gmail inbox.';

const flawedPlan: TransformedBuildPlan = {
  // Flaw 1 (scope_honesty): goal says "drafts replies" — fine. But finalProduct
  // quietly upgrades to "auto-sends" which is a meaningful overreach for a
  // 3-hour build-along video.
  goal:
    'Build a Claude-powered AI email reply assistant that drafts contextual ' +
    'replies for messages in the user\'s Gmail inbox, with a one-click insert ' +
    'into the Gmail compose window.',
  finalProduct:
    'A working end-to-end assistant that reads incoming Gmail threads, ' +
    'classifies them by intent, drafts a reply with Claude, AUTO-SENDS the ' +
    'reply when confidence is high, and logs every send to a Google Sheet.',

  toolchain: [
    { name: 'Claude API', role: 'reply generation', source: 'given' },
    { name: 'Gmail API', role: 'inbox read + compose', source: 'given' },
    { name: 'Node.js + TypeScript', role: 'backend runtime', source: 'assumed' },
    // Flaw 2 (dependency_completeness): no mention of OAuth setup, no token
    // store, no GCP project provisioning — all required for Gmail API.
  ],

  buildSteps: [
    {
      title: 'Scaffold the Node project',
      description: 'npm init, install @anthropic-ai/sdk and googleapis.',
      estimatedMinutes: 10,
    },
    {
      title: 'Connect to Gmail',
      description: 'Call gmail.users.messages.list and dump the latest 5.',
      estimatedMinutes: 10,
    },
    // Flaw 3 (timeline_realism): "Build the classifier" in 15 min — Claude
    // call + prompt iteration alone takes longer than that on first try.
    {
      title: 'Build the intent classifier',
      description:
        'Prompt Claude to classify each thread as question/request/social.',
      estimatedMinutes: 15,
    },
    {
      title: 'Draft replies',
      description: 'Prompt Claude to draft a reply using the thread body as context.',
      estimatedMinutes: 20,
    },
    // Flaw 4 (effort_distribution): "Auto-send on high confidence" gets 5
    // minutes — this is the riskiest step of the entire build (sends real
    // email, hard to undo) and it's compressed to a near-token.
    {
      title: 'Auto-send on high confidence',
      description: 'If Claude returns confidence >= 0.85, send the reply via Gmail API.',
      estimatedMinutes: 5,
    },
    {
      title: 'Log every send to Google Sheets',
      description: 'Append row { threadId, sentAt, replyPreview } to a sheet.',
      estimatedMinutes: 15,
    },
    // Flaw 5 (risk_visibility): no step acknowledges auth failure handling,
    // hallucinated reply content, sending to the wrong person, or
    // rate-limit/quota — all production-shaped failure modes.
  ],

  shotHints: [
    'Show the Gmail inbox in browser',
    'Show terminal scrolling Claude reply drafts',
    'Show a single Auto-sent reply appearing in Sent folder',
    'Show the Google Sheet log row',
    'Final shot: empty inbox after the assistant cleared everything',
  ],
};

// Same brief, production-realistic plan. Goal/finalProduct in lock-step;
// OAuth provisioning called out; effort weights the risky steps; explicit
// risk-handling steps. The critic should produce few or zero findings.
const cleanPlan: TransformedBuildPlan = {
  goal:
    'Build a Claude-powered AI email reply assistant that reads incoming ' +
    'Gmail threads and surfaces a draft reply in a side panel for the ' +
    'user to review, edit, and one-click insert into the Gmail compose ' +
    'window. Human always in the loop — the assistant never sends.',
  finalProduct:
    'A local Node/TypeScript service + minimal web UI that reads the ' +
    'user\'s unread Gmail threads via OAuth, calls Claude with the thread ' +
    'context, and renders a draft reply the user can edit and click to ' +
    'paste back into Gmail compose. No auto-send, no background activity.',

  toolchain: [
    { name: 'Claude API (@anthropic-ai/sdk)', role: 'reply generation', source: 'given' },
    { name: 'Gmail API (googleapis)', role: 'authenticated inbox read', source: 'given' },
    { name: 'Google Cloud Console', role: 'OAuth client provisioning + scopes', source: 'assumed' },
    { name: 'Node.js + TypeScript', role: 'backend runtime', source: 'assumed' },
    { name: 'Express + minimal HTML', role: 'local review UI on localhost:3000', source: 'assumed' },
  ],

  buildSteps: [
    {
      title: 'Provision a Google Cloud OAuth client',
      description:
        'In GCP Console: create project, enable Gmail API, configure OAuth ' +
        'consent screen (External, testing mode), create OAuth Desktop client. ' +
        'Download credentials.json. Scope: gmail.readonly only — we never send.',
      estimatedMinutes: 20,
    },
    {
      title: 'OAuth flow + persist refresh token',
      description:
        'Implement the one-time consent flow (open browser, capture code, ' +
        'exchange for refresh token). Persist refresh token to a gitignored ' +
        'token.json. Handle the "user denied consent" path explicitly.',
      estimatedMinutes: 30,
    },
    {
      title: 'Read unread threads from Gmail',
      description:
        'Call gmail.users.threads.list with q="is:unread in:inbox -category:promotions" ' +
        'and fetch full thread bodies. Strip quoted history. Cap at 10 threads ' +
        'per run to control quota.',
      estimatedMinutes: 25,
    },
    {
      title: 'Build the Claude reply prompt',
      description:
        'Construct a prompt that gives Claude the thread body + user\'s ' +
        'persona/role + reply guidelines (concise, match tone, never fabricate ' +
        'meeting times or commitments). Iterate on 5 sample threads.',
      estimatedMinutes: 45,
    },
    {
      title: 'Generate drafts + handle Claude failures',
      description:
        'For each thread, call Claude. Catch timeout, rate-limit (429), and ' +
        'invalid-output cases. On failure, mark the thread "draft unavailable" ' +
        'and continue. Never crash the whole batch on one bad thread.',
      estimatedMinutes: 30,
    },
    {
      title: 'Review UI on localhost',
      description:
        'Render the threads + drafts in a simple HTML page. Each card shows: ' +
        'sender, subject, original snippet, draft, an Edit textarea, a ' +
        '"Copy to clipboard" button. No send button anywhere — that\'s ' +
        'the safety story.',
      estimatedMinutes: 40,
    },
    {
      title: 'Hallucination + wrong-recipient guardrails (demo step)',
      description:
        'On screen: show 2 cases where the draft would hallucinate (made-up ' +
        'meeting time, fabricated invoice number) and explain why the ' +
        'human-in-the-loop step matters. This is the trust story for the video.',
      estimatedMinutes: 20,
    },
    {
      title: 'End-to-end run + 5-thread demo',
      description:
        'Final live run with 5 representative unread threads. Walk through ' +
        'editing one draft, copying it into Gmail, and explicitly NOT ' +
        'clicking send until the human confirms.',
      estimatedMinutes: 20,
    },
  ],

  shotHints: [
    'GCP Console: OAuth consent screen + Gmail API enable toggle',
    'Terminal: first refresh-token flow opening browser',
    'Terminal: 10 threads fetched, drafts streaming in',
    'Localhost UI: card grid of threads + editable drafts',
    'Live edit of a draft — typo fix, tone shift',
    'Copy-to-clipboard button click → paste into Gmail compose',
    'Hallucination call-out: side-by-side draft vs ground truth',
    'Final shot: human cursor hovering Gmail Send button (NOT clicked)',
  ],
};

const CRITERION_IDS = [
  'scope_honesty',
  'timeline_realism',
  'dependency_completeness',
  'effort_distribution',
  'risk_visibility',
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const useClean = process.argv.includes('--clean');
  const plan = useClean ? cleanPlan : flawedPlan;
  const label = useClean ? 'CLEAN' : 'FLAWED';
  const provider = new StandaloneClaudeProvider();

  console.log(`=== Dogfood: AI Email Reply Assistant brief (${label} plan) ===`);
  console.log(`Criteria version: ${CRITERIA_VERSION}`);
  console.log(`Plan steps: ${plan.buildSteps.length}`);

  if (dryRun) {
    // Print the prompt that would be sent. Useful when running anywhere
    // that doesn't have an authenticated Claude CLI.
    const criteria = CRITERION_IDS.map((id) => getCriterion(id)).filter(
      (c): c is NonNullable<ReturnType<typeof getCriterion>> => c !== undefined,
    );
    const prompt = buildCriticPrompt(plan, briefGoal, criteria);
    const suffix = useClean ? 'clean' : 'flawed';
    const promptPath = `/tmp/dogfood-critic-prompt-${suffix}.txt`;
    writeFileSync(promptPath, prompt, 'utf8');
    console.log(`\n[dry-run] Wrote ${prompt.length} chars to ${promptPath}`);
    console.log('--- prompt preview (first 60 lines) ---');
    console.log(prompt.split('\n').slice(0, 60).join('\n'));
    console.log('...');
    return;
  }

  console.log(
    'Calling critiquePlan() against all 5 v1 criteria... (this calls Claude CLI; will take ~30-90s)\n',
  );

  const start = Date.now();
  const out: CritiqueResult | CritiqueUnavailable = await critiquePlan({
    plan,
    goalSummary: briefGoal,
    criteriaIds: CRITERION_IDS,
    provider,
    timeoutMs: 180_000, // Opus on a 13K-char prompt regularly takes 60-120s.
    onReferenceHallucination: (citedId) => {
      console.log(`[guard] dropped hallucinated criterion_id: ${citedId}`);
    },
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`\n=== Result (${elapsed}s) ===`);
  console.log(`ran: ${out.ran}`);
  if (!out.ran) {
    console.log(`reason: ${out.reason}`);
    console.log(`attempts: ${out.attemptCount}`);
    return;
  }
  console.log(`model: ${out.modelUsed}`);
  console.log(`attempts: ${out.attemptCount}`);
  console.log(`findings: ${out.findings.length}\n`);

  for (const [i, f] of out.findings.entries()) {
    console.log(`#${i + 1}  [${f.severity.toUpperCase()} / ${f.confidence}]  ${f.criterionId}`);
    console.log(`     issue: ${f.issue}`);
    console.log(`     fix:   ${f.suggestedFix}`);
    if (f.stepRef) console.log(`     ref:   ${f.stepRef}`);
    console.log();
  }

  if (useClean) {
    // Clean plan: any finding is potentially a false positive. Report each
    // by criterion so we can decide whether the criterion's threshold is
    // too aggressive.
    console.log('=== Clean-plan report (expected: 0 findings) ===');
    if (out.findings.length === 0) {
      console.log('  OK — critic stayed quiet on the clean plan.');
    } else {
      console.log(
        `  WARN — critic emitted ${out.findings.length} findings on a clean plan.`,
      );
      console.log(
        '         Review each: is the criterion catching a real issue or being trigger-happy?',
      );
    }
    return;
  }

  // Baited-flaw coverage report for the flawed plan.
  const baited = {
    scope_honesty: 'goal/finalProduct mismatch (drafts vs auto-sends)',
    dependency_completeness: 'missing OAuth/GCP provisioning',
    timeline_realism: '15-min classifier step is optimistic',
    effort_distribution: 'auto-send compressed to 5 min',
    risk_visibility: 'no auth-fail / hallucination / wrong-recipient steps',
  };
  const hits = new Set(out.findings.map((f) => f.criterionId));

  console.log('=== Baited-flaw coverage ===');
  for (const [id, description] of Object.entries(baited)) {
    const status = hits.has(id) ? 'HIT ' : 'MISS';
    console.log(`  ${status}  ${id}  —  ${description}`);
  }
}

main().catch((err) => {
  console.error('dogfood failed:', err);
  process.exit(1);
});
