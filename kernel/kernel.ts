import type { AuditLog } from './audit.ts';
import { cloneJson, digest } from './canonical.ts';
import type { Policy, PolicyDecision } from './policy.ts';
import { checkApprover, checkRejecter, decide } from './policy.ts';
import type { Store } from './store.ts';
import type { Case, CaseAction, Evidence, Finding, Invoice, PurchaseOrder, Receipt, Supplier } from './types.ts';
import type { Actor, AgentId } from './identity.ts';
import { isActor } from './identity.ts';
import { Executor } from './executor.ts';
import { validateProposal } from './proposal.ts';
import type { Proposal } from './proposal.ts';
import { VERBS } from './verbs.ts';
import { usd } from './money.ts';

// The kernel ties the pieces together. Agents get three things from it:
// audited read access (copies, never live records), a way to open a case, and
// a way to submit a proposal. They never touch the store, the executor, or
// the policy configuration. People get one more thing: decide().

export interface KernelOptions {
  store: Store;
  audit: AuditLog;
  policy: Policy;
  clock?: () => Date;
}

export interface ScreeningView {
  suppliers: Supplier[];
  purchaseOrders: PurchaseOrder[];
  receipts: Receipt[];
  invoices: Invoice[];
}

export type SubmitResult =
  | { ok: true; proposal: Proposal; actions: CaseAction[] }
  | { ok: false; errors: string[] };

export type DecideResult = { ok: true; action: CaseAction } | { ok: false; reason: string };

export class Kernel {
  readonly policy: Policy;
  readonly #store: Store;
  readonly #audit: AuditLog;
  readonly #executor: Executor;
  readonly #clock: () => Date;

  constructor(opts: KernelOptions) {
    this.policy = opts.policy;
    this.#store = opts.store;
    this.#audit = opts.audit;
    this.#clock = opts.clock ?? (() => new Date());
    this.#executor = new Executor(this.#store, this.#audit, this.policy, this.#clock);
    this.#audit.append('SYSTEM', 'system:kernel', null, `Policy ${this.policy.version} in force; standing approval ${this.policy.signedBy ? `signed by ${this.policy.signedBy}` : 'absent (unsigned policy)'}`, {
      policyVersion: this.policy.version,
      policyHash: this.policy.hash,
      signedBy: this.policy.signedBy,
      signedAt: this.policy.signedAt,
    });
  }

  get companyName(): string {
    return this.#store.companyName;
  }

  // ---- reads ---------------------------------------------------------------

  /** Copies of everything screening needs, recorded as one READ entry. */
  readForScreening(actor: AgentId): ScreeningView {
    const view: ScreeningView = cloneJson({
      suppliers: [...this.#store.suppliers.values()],
      purchaseOrders: [...this.#store.purchaseOrders.values()],
      receipts: [...this.#store.receipts.values()],
      invoices: [...this.#store.invoices.values()],
    });
    this.#audit.append('READ', actor, null, `Read ${view.invoices.length} invoices, ${view.purchaseOrders.length} POs, ${view.receipts.length} receipts for screening`, {
      sha256: digest(view),
    });
    return view;
  }

  /** Audited, case-scoped reads. Every read becomes citable evidence on the case. */
  reads(caseId: string, actor: AgentId): CaseReads {
    const c = this.#case(caseId);
    const record = (source: string, ref: string, summary: string, snapshot: unknown): Evidence => {
      const copy = snapshot === undefined ? null : cloneJson(snapshot);
      const ev: Evidence = { id: this.#store.nextId('EV'), source, ref, summary, snapshot: copy, sha256: digest(copy) };
      c.evidence.push(ev);
      this.#audit.append('READ', actor, c.id, `${ev.id} ${summary}`, { evidenceId: ev.id, source, ref, sha256: ev.sha256 });
      return cloneJson(ev);
    };
    const store = this.#store;
    return {
      invoice: (id) => {
        const inv = store.invoices.get(id);
        return record('invoices', id, inv ? `Invoice ${id} (${inv.supplierInvoiceNo}) ${usd(inv.totalUsd)}, ${inv.poId ? `against ${inv.poId}` : 'no PO reference'}` : `Invoice ${id} not found`, inv ?? null);
      },
      purchaseOrder: (id) => {
        const po = store.purchaseOrders.get(id);
        return record('purchase_orders', id, po
          ? `${id}: ${po.lines.map((l) => `${l.qty.toLocaleString('en-US')} x ${l.sku} @ ${usd(l.unitPriceUsd)}`).join('; ')}`
          : `${id} not found in the PO register`, po ?? null);
      },
      receiptsForPo: (poId) => {
        const rs = store.receiptsForPo(poId);
        const qty = rs.flatMap((r) => r.lines).reduce((s, l) => s + l.qtyReceived, 0);
        return record('receipts', poId, rs.length
          ? `Receipts for ${poId}: ${rs.map((r) => r.id).join(', ')} (${qty.toLocaleString('en-US')} units received)`
          : `No receipts posted against ${poId}`, rs);
      },
      supplier: (id) => {
        const s = store.suppliers.get(id);
        return record('suppliers', id, s ? `Supplier ${s.name}, AP contact ${s.apEmail}` : `Supplier ${id} not found`, s ?? null);
      },
      supplierInvoices: (supplierId) => {
        const list = store.invoicesForSupplier(supplierId).map((i) => ({
          id: i.id, supplierInvoiceNo: i.supplierInvoiceNo, poId: i.poId, invoiceDate: i.invoiceDate, receivedOn: i.receivedOn, totalUsd: i.totalUsd, status: i.status,
        }));
        return record('invoices', `supplier:${supplierId}`, `${list.length} invoices on file for ${supplierId}`, list);
      },
    };
  }

  // ---- cases ---------------------------------------------------------------

  openCase(actor: AgentId, invoiceId: string, findings: Finding[]): Case {
    const inv = this.#store.invoices.get(invoiceId);
    if (!inv) throw new Error(`invoice ${invoiceId} not found`);
    if (!findings.length) throw new Error('a case needs at least one finding');
    const existing = [...this.#store.cases.values()].find((c) => c.invoiceId === invoiceId);
    if (existing) return cloneJson(existing);
    const c: Case = {
      id: this.#store.nextId('CASE'),
      invoiceId,
      supplierId: inv.supplierId,
      primaryType: findings[0]!.type,
      findings: cloneJson(findings),
      evidence: [],
      state: 'detected',
      proposal: null,
      plannedBy: null,
      actions: [],
      escalationReason: null,
      openedAt: this.#clock().toISOString(),
    };
    this.#store.cases.set(c.id, c);
    const atStake = Math.max(...findings.map((f) => f.amountAtStakeUsd));
    this.#audit.append('SYSTEM', actor, c.id, `Opened ${c.id}: ${findings.map((f) => f.type).join(' + ')} on ${invoiceId} (${usd(atStake)} at stake)`, {
      invoiceId, findings,
    });
    return cloneJson(c);
  }

  recordInference(actor: AgentId, caseId: string, summary: string, data: unknown): void {
    this.#case(caseId);
    this.#audit.append('INFERENCE', actor, caseId, summary, data);
  }

  /** Validate a planner's proposal, run each action through policy, execute what the standing approval covers. */
  submitProposal(actor: AgentId, caseId: string, raw: unknown, plannedBy: string): SubmitResult {
    const c = this.#case(caseId);
    if (c.proposal) return { ok: false, errors: [`${caseId} already has an accepted proposal`] };

    const validation = validateProposal(raw, { store: this.#store, caseRecord: c, directory: this.policy.directory }, plannedBy);
    if (!validation.ok) {
      this.#audit.append('PROPOSAL', actor, c.id, `Proposal from ${plannedBy} rejected: ${validation.errors.length} problem(s)`, {
        plannedBy, errors: validation.errors, raw: safeJson(raw),
      });
      return validation;
    }

    const proposal = validation.proposal;
    c.proposal = proposal;
    c.plannedBy = plannedBy;
    this.#audit.append('PROPOSAL', actor, c.id, `Proposal from ${plannedBy} accepted: ${proposal.classification}, confidence ${proposal.confidenceBand} (${proposal.confidence.toFixed(2)}), ${proposal.actions.length} action(s)`, {
      plannedBy,
      classification: proposal.classification,
      diagnosis: proposal.diagnosis,
      confidenceBand: proposal.confidenceBand,
      confidence: proposal.confidence,
      citations: proposal.citations,
    });

    const ctx = { store: this.#store, caseRecord: c, directory: this.policy.directory };
    for (const pa of proposal.actions) {
      const amount = VERBS[pa.verb].amountAtStakeUsd(pa.params, ctx);
      const decision: PolicyDecision = decide(this.policy, {
        verb: pa.verb, amountAtStakeUsd: amount, confidence: proposal.confidence, exceptionType: c.primaryType,
      });
      const action: CaseAction = {
        id: this.#store.nextId('ACT'),
        caseId: c.id,
        verb: pa.verb,
        params: pa.params,
        rationale: pa.rationale,
        amountAtStakeUsd: amount,
        decision,
        status: decision.outcome === 'blocked' ? 'blocked' : decision.outcome === 'autonomous' ? 'auto_approved' : 'awaiting_human',
        decidedBy: null,
        decidedAt: null,
        rejectionReason: null,
        result: null,
        executedAt: null,
      };
      c.actions.push(action);
      const who = decision.outcome === 'needs_human' ? ` (eligible: ${decision.eligibleRoles.join(', ')})` : '';
      this.#audit.append('POLICY_DECISION', 'system:policy', c.id, `${action.id} ${pa.verb} ${usd(amount)} -> ${decision.outcome}${who}`, {
        actionId: action.id, verb: pa.verb, params: pa.params, rationale: pa.rationale, ...decision,
      });
    }

    for (const action of c.actions) {
      if (action.status !== 'auto_approved' || !this.policy.signedBy) continue;
      try {
        this.#executor.execute(c, action, {
          kind: 'standing_approval', signedBy: this.policy.signedBy, policyVersion: this.policy.version, policyHash: this.policy.hash,
        });
      } catch (e) {
        // The executor already wrote a REFUSAL entry with the reason.
        action.status = 'blocked';
        action.result = `refused by executor: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    this.#settle(c);
    return { ok: true, proposal: cloneJson(proposal), actions: cloneJson(c.actions) };
  }

  /** Every planner failed: escalate the case without taking any action. */
  escalateUnplanned(actor: AgentId, caseId: string, reason: string): void {
    const c = this.#case(caseId);
    c.state = 'escalated';
    c.escalationReason = reason;
    this.#audit.append('SYSTEM', actor, c.id, `${c.id} escalated with no actions: ${reason}`, { reason });
  }

  // ---- people --------------------------------------------------------------

  /** A person approves or rejects one action. Agents are refused here by construction. */
  decide(caseId: string, actionId: string, identity: string, decision: 'approve' | 'reject', reason = ''): DecideResult {
    const c = this.#case(caseId);
    const action = c.actions.find((a) => a.id === actionId);
    const refuse = (why: string): DecideResult => {
      const actor: Actor = isActor(identity) ? identity : 'system:kernel';
      this.#audit.append('REFUSAL', actor, c.id, `${decision} of ${actionId} by ${identity} refused: ${why}`, { actionId, identity, decision, reason: why });
      return { ok: false, reason: why };
    };
    if (!action) return refuse('no such action');
    if (action.status !== 'awaiting_human') return refuse(`action is ${action.status}, not awaiting a person`);

    const check = decision === 'approve' ? checkApprover(this.policy, action.decision, identity) : checkRejecter(this.policy, identity);
    if (!check.ok) return refuse(check.reason);
    if (decision === 'reject' && !reason.trim()) return refuse('a rejection needs a reason');

    const now = this.#clock().toISOString();
    action.decidedBy = check.approver;
    action.decidedAt = now;
    this.#audit.append('HUMAN_DECISION', check.approver, c.id, `${decision === 'approve' ? 'APPROVED' : 'REJECTED'} ${action.id} ${action.verb} ${usd(action.amountAtStakeUsd)} (${check.person.name}, ${check.person.role})${reason ? `: ${reason}` : ''}`, {
      actionId: action.id, verb: action.verb, decision, role: check.person.role, reason: reason || null, policyHash: this.policy.hash,
    });

    if (decision === 'reject') {
      action.status = 'rejected';
      action.rejectionReason = reason;
    } else {
      action.status = 'approved';
      try {
        this.#executor.execute(c, action, { kind: 'human_approval', approver: check.approver, decidedAt: now });
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        action.status = 'blocked';
        action.result = `refused by executor: ${why}`;
        this.#settle(c);
        return { ok: false, reason: why };
      }
    }
    this.#settle(c);
    return { ok: true, action: cloneJson(action) };
  }

  // ---- views ---------------------------------------------------------------

  cases(): Case[] {
    return cloneJson([...this.#store.cases.values()]);
  }

  pending(): { caseRecord: Case; action: CaseAction }[] {
    return this.cases().flatMap((c) => c.actions.filter((a) => a.status === 'awaiting_human').map((action) => ({ caseRecord: c, action })));
  }

  /** Read-only snapshot of all state, for reports and tests. */
  snapshot(): ReturnType<Store['snapshot']> {
    return cloneJson(this.#store.snapshot());
  }

  #case(caseId: string): Case {
    const c = this.#store.cases.get(caseId);
    if (!c) throw new Error(`case ${caseId} not found`);
    return c;
  }

  #settle(c: Case): void {
    const before = c.state;
    const statuses = c.actions.map((a) => a.status);
    if (statuses.includes('awaiting_human')) c.state = 'awaiting_human';
    else if (statuses.includes('rejected')) c.state = 'needs_follow_up';
    else if (c.actions.some((a) => a.verb === 'ESCALATE' && a.status === 'executed')) c.state = 'escalated';
    else if (statuses.includes('blocked')) c.state = 'needs_follow_up';
    else if (statuses.includes('executed')) c.state = 'actions_executed';
    else c.state = 'escalated';
    if (c.state === 'escalated' && !c.escalationReason) c.escalationReason = 'no action could be executed';
    if (c.state !== before) {
      this.#audit.append('SYSTEM', 'system:kernel', c.id, `${c.id} state ${before} -> ${c.state}`, { from: before, to: c.state });
    }
  }
}

export interface CaseReads {
  invoice(id: string): Evidence;
  purchaseOrder(id: string): Evidence;
  receiptsForPo(poId: string): Evidence;
  supplier(id: string): Evidence;
  supplierInvoices(supplierId: string): Evidence;
}

function safeJson(value: unknown): unknown {
  try {
    return cloneJson(value);
  } catch {
    return String(value);
  }
}
