import type { AuditLog } from './audit.ts';
import type { Policy } from './policy.ts';
import type { Store } from './store.ts';
import type { Case, CaseAction } from './types.ts';
import type { HumanId } from './identity.ts';
import { isHumanId } from './identity.ts';
import { VERBS } from './verbs.ts';

// The executor is the only code path that changes a business record. It
// accepts an action plus the authority it executes under, and refuses unless:
//
//   - the verb is in the frozen kernel table (there is no way to register one),
//   - the authority names a person in the policy directory, either the person
//     who approved this specific action or the person who signed the policy
//     whose standing approval covers it,
//   - the action's status matches that authority,
//   - the action has not already run, and
//   - the verb's checks still pass against current records.
//
// Every execution and every refusal is written to the audit log. Executed
// actions are logged with the authorizing person as the actor.

export type Authority =
  | { kind: 'human_approval'; approver: HumanId; decidedAt: string }
  | { kind: 'standing_approval'; signedBy: HumanId; policyVersion: string; policyHash: string };

export class ExecutionRefused extends Error {
  override name = 'ExecutionRefused';
}

export class Executor {
  readonly #store: Store;
  readonly #audit: AuditLog;
  readonly #policy: Policy;
  readonly #clock: () => Date;

  constructor(store: Store, audit: AuditLog, policy: Policy, clock: () => Date = () => new Date()) {
    this.#store = store;
    this.#audit = audit;
    this.#policy = policy;
    this.#clock = clock;
    Object.freeze(this);
  }

  execute(caseRecord: Case, action: CaseAction, authority: Authority): string {
    const refuse = (reason: string): never => {
      this.#audit.append('REFUSAL', 'system:executor', caseRecord.id, `Executor refused ${String(action.verb)} (${action.id}): ${reason}`, {
        actionId: action.id, verb: String(action.verb), reason,
      });
      throw new ExecutionRefused(reason);
    };

    if (typeof action.verb !== 'string' || !Object.hasOwn(VERBS, action.verb)) {
      return refuse(`${String(action.verb)} is not a kernel verb; the vocabulary is closed`);
    }
    const spec = VERBS[action.verb];

    if (action.status === 'executed' || action.executedAt) return refuse('action already executed');

    const actor = this.#authorize(action, authority, refuse);

    const ctx = { store: this.#store, caseRecord, directory: this.#policy.directory, authorizedBy: actor };
    const problems = spec.check(action.params, ctx);
    if (problems.length) return refuse(`checks failed against current records: ${problems.join('; ')}`);

    const result = spec.apply(action.params, ctx);
    action.status = 'executed';
    action.result = result;
    action.executedAt = this.#clock().toISOString();

    const via = authority.kind === 'human_approval'
      ? `approved by ${authority.approver}`
      : `standing approval, policy ${authority.policyVersion} signed by ${authority.signedBy}`;
    this.#audit.append('ACTION', actor, caseRecord.id, `${action.verb} executed (${via}): ${result}`, {
      actionId: action.id,
      verb: action.verb,
      params: action.params,
      amountAtStakeUsd: action.amountAtStakeUsd,
      authority,
      result,
    });
    return result;
  }

  #authorize(action: CaseAction, authority: Authority, refuse: (reason: string) => never): HumanId {
    if (!authority || typeof authority !== 'object') return refuse('no authority supplied; every mutation needs a named person');
    if (authority.kind === 'human_approval') {
      if (!isHumanId(authority.approver)) return refuse(`approver ${String(authority.approver)} is not a human identity`);
      if (!Object.hasOwn(this.#policy.directory, authority.approver)) return refuse(`approver ${authority.approver} is not in the policy directory`);
      if (action.status !== 'approved') return refuse(`action status is ${action.status}, not approved`);
      if (action.decidedBy !== authority.approver) return refuse('approver does not match the recorded decision');
      return authority.approver;
    }
    if (authority.kind === 'standing_approval') {
      if (!isHumanId(authority.signedBy)) return refuse('standing approval must name a human signer');
      if (this.#policy.signedBy !== authority.signedBy || this.#policy.hash !== authority.policyHash) {
        return refuse('standing approval does not match the signed policy in force');
      }
      if (action.status !== 'auto_approved' || action.decision.outcome !== 'autonomous') {
        return refuse(`action status is ${action.status}; only actions the policy marked autonomous can use the standing approval`);
      }
      if (action.decision.policyHash !== this.#policy.hash) return refuse('action was decided under a different policy');
      return authority.signedBy;
    }
    return refuse('no authority supplied; every mutation needs a named person');
  }
}
