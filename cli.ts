import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { readAuditFile, verifyChain } from './kernel/audit.ts';
import type { AuditEntry } from './kernel/audit.ts';
import { plannerFromName, PLANNER_NAMES } from './agents/llm/from-env.ts';
import { runDemo } from './demo/run.ts';

const USAGE = `approval-gated-agent

Usage:
  node cli.ts demo   [--planner ${PLANNER_NAMES.join('|')}] [--interactive] [--out DIR] [--real-clock]
  node cli.ts verify [FILE] [--head HASH]
  node cli.ts audit  [FILE] [--case CASE-0001] [--kind ACTION] [--actor human:] [--json]

Defaults: --planner playbook, --out out, FILE out/audit.jsonl.
The demo runs offline with no API key. See README.md.`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'demo': return demo(rest);
    case 'verify': return verify(rest);
    case 'audit': return showAudit(rest);
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 2;
  }
}

async function demo(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      planner: { type: 'string', default: process.env.PLANNER ?? 'playbook' },
      interactive: { type: 'boolean', default: false },
      out: { type: 'string', default: 'out' },
      'real-clock': { type: 'boolean', default: false },
    },
  });
  const planner = plannerFromName(values.planner);
  const result = await runDemo({
    outDir: values.out,
    planner,
    interactive: values.interactive,
    realClock: values['real-clock'],
  });
  const ok = result.verify.ok && !result.tamperCheck.ok && !result.truncationCheck.ok;
  return ok ? 0 : 1;
}

function verify(args: string[]): number {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { head: { type: 'string' } } });
  const file = positionals[0] ?? 'out/audit.jsonl';
  if (!existsSync(file)) {
    console.error(`No audit log at ${file}. Run "npm run demo" first, or pass a path.`);
    return 2;
  }
  const { entries, problems } = readAuditFile(file);
  const r = verifyChain(entries, { parseProblems: problems, ...(values.head ? { expectedHead: values.head } : {}) });
  if (r.ok) {
    console.log(`OK  ${file}: ${r.count} entries, chain intact${values.head ? ', head matches' : ''}`);
    console.log(`    head ${r.head}`);
    const humans = new Set(entries.filter((e) => e.kind === 'ACTION').map((e) => e.actor));
    console.log(`    ${entries.filter((e) => e.kind === 'ACTION').length} executed actions, authorized by: ${[...humans].join(', ') || 'none'}`);
    return 0;
  }
  console.log(`FAIL ${file}: ${r.problem}`);
  if (r.firstBadSeq !== null) console.log(`     first bad entry: seq ${r.firstBadSeq}; entries before it are intact`);
  return 1;
}

function showAudit(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      case: { type: 'string' },
      kind: { type: 'string' },
      actor: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
  });
  const file = positionals[0] ?? 'out/audit.jsonl';
  if (!existsSync(file)) {
    console.error(`No audit log at ${file}. Run "npm run demo" first, or pass a path.`);
    return 2;
  }
  const { entries } = readAuditFile(file);
  const rows = entries.filter((e: AuditEntry) =>
    (!values.case || e.caseId === values.case) &&
    (!values.kind || e.kind === values.kind.toUpperCase()) &&
    (!values.actor || e.actor.startsWith(values.actor)));
  if (values.json) {
    for (const e of rows) console.log(JSON.stringify(e));
    return 0;
  }
  for (const e of rows) {
    console.log(`${String(e.seq).padStart(4)}  ${e.at.slice(0, 19).replace('T', ' ')}  ${e.kind.padEnd(15)} ${(e.caseId ?? '').padEnd(9)} ${e.actor}`);
    console.log(`      ${e.summary}`);
  }
  console.log(`\n${rows.length} of ${entries.length} entries. Run "npm run verify" to check the chain.`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err: unknown) => {
    console.error(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    process.exitCode = 1;
  },
);
