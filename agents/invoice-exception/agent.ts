import type { Kernel } from '../../kernel/kernel.ts';
import type { AgentId } from '../../kernel/identity.ts';
import type { Case } from '../../kernel/types.ts';
import type { Planner } from '../planner.ts';
import { PlaybookPlanner } from './playbooks.ts';
import { screenAll } from './screen.ts';
import { investigate } from './investigate.ts';

// The invoice-exception agent: screen every open invoice, open a case for
// each mismatch, investigate it through audited reads, ask a planner for a
// proposal, and hand the proposal to the kernel. It cannot approve or execute
// anything. If the chosen planner fails or proposes something the kernel
// rejects, the deterministic playbook runs instead; if that also fails, the
// case is escalated to a person with no action taken.

export const AGENT_ID: AgentId = 'agent:invoice-exception';

export interface AgentRunSummary {
  screened: number;
  clean: string[];
  cases: { caseId: string; invoiceId: string; type: string; plannedBy: string | null; state: Case['state'] }[];
}

export interface AgentOptions {
  /** Used when the primary planner throws or its proposal is rejected. Defaults to the playbook. */
  fallback?: Planner | null;
}

export class InvoiceExceptionAgent {
  readonly #kernel: Kernel;
  readonly #planner: Planner;
  readonly #fallback: Planner | null;

  constructor(kernel: Kernel, planner: Planner = new PlaybookPlanner(), opts: AgentOptions = {}) {
    this.#kernel = kernel;
    this.#planner = planner;
    const fallback = opts.fallback === undefined ? new PlaybookPlanner() : opts.fallback;
    this.#fallback = fallback && fallback.id !== planner.id ? fallback : null;
  }

  /** Screen, open cases, investigate, propose. Returns once every case has a proposal or is escalated. */
  async run(): Promise<AgentRunSummary> {
    const view = this.#kernel.readForScreening(AGENT_ID);
    const results = screenAll(view, this.#kernel.policy.screening);
    const clean = results.filter((r) => !r.findings.length).map((r) => r.invoiceId);

    const opened: Case[] = [];
    for (const r of results) {
      if (r.findings.length) opened.push(this.#kernel.openCase(AGENT_ID, r.invoiceId, r.findings));
    }
    for (const c of opened) await this.#planCase(c);

    const all = this.#kernel.cases();
    return {
      screened: results.length,
      clean,
      cases: opened.map((o) => {
        const c = all.find((x) => x.id === o.id)!;
        return { caseId: c.id, invoiceId: c.invoiceId, type: c.primaryType, plannedBy: c.plannedBy, state: c.state };
      }),
    };
  }

  async #planCase(c: Case): Promise<void> {
    const input = investigate(this.#kernel.reads(c.id, AGENT_ID), c, this.#kernel.companyName, this.#kernel.policy);
    const planners = this.#fallback ? [this.#planner, this.#fallback] : [this.#planner];

    for (const planner of planners) {
      let raw: unknown;
      try {
        const result = await planner.plan(input);
        raw = result.raw;
        this.#kernel.recordInference(AGENT_ID, c.id, `Planner ${planner.id}${result.model ? ` (${result.model})` : ''} returned a proposal`, {
          planner: planner.id, model: result.model ?? null, usage: result.usage ?? null, proposal: toJson(raw),
        });
      } catch (e) {
        this.#kernel.recordInference(AGENT_ID, c.id, `Planner ${planner.id} failed: ${e instanceof Error ? e.message : String(e)}`, {
          planner: planner.id, error: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      const submitted = this.#kernel.submitProposal(AGENT_ID, c.id, raw, planner.id);
      if (submitted.ok) return;
    }
    this.#kernel.escalateUnplanned(AGENT_ID, c.id, 'no planner produced a proposal the kernel accepted');
  }
}

function toJson(value: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}
