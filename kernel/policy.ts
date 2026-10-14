import type { ExceptionType } from './types.ts';
import { EXCEPTION_TYPES } from './types.ts';
import type { HumanId } from './identity.ts';
import { isAgentId, isHumanId } from './identity.ts';
import { VERBS, VERB_NAMES, isVerb } from './verbs.ts';
import type { Verb } from './verbs.ts';
import { digest } from './canonical.ts';
import { usd } from './money.ts';

// The policy engine is plain, deterministic code. A planner proposes; this
// decides, for each proposed action, one of three outcomes:
//
//   blocked      the verb is unknown or switched off. Nothing happens.
//   autonomous   the action falls inside a standing approval: a policy that
//                a named person signed. It executes under that person's name.
//   needs_human  a person in an eligible role must approve this specific
//                action before it executes.
//
// The configuration (thresholds, confidence floor, approval matrix, people)
// is data that a controller owns and signs. The rules that read it are code.

export interface VerbRule {
  enabled: boolean;
  /** Largest dollar amount this verb may execute under the standing approval. null = always a person. */
  autonomousUpToUsd: number | null;
}

export interface ApprovalBand {
  /** Upper bound of this band in dollars; null means no upper bound. */
  upToUsd: number | null;
  roles: string[];
}

export interface Person {
  name: string;
  role: string;
}

export interface ScreeningTolerances {
  /** Unit price may exceed the PO price by this percentage before it is a variance. */
  priceTolerancePct: number;
  /** Billed quantity may exceed received quantity by this percentage before it is a variance. */
  qtyTolerancePct: number;
}

export interface PolicyConfig {
  version: string;
  /** The person whose signature makes the standing approval valid. null = no autonomy at all. */
  signedBy: HumanId | null;
  signedAt: string | null;
  /** Below this mapped confidence, every action needs a person. */
  confidenceFloor: number;
  verbs: Partial<Record<string, VerbRule>>;
  approvalMatrix: {
    bands: ApprovalBand[];
    /** Extra restriction by exception type, intersected with the band. */
    minimumRolesByException?: Partial<Record<ExceptionType, string[]>>;
  };
  directory: Record<string, Person>;
  screening: ScreeningTolerances;
}

export interface Policy extends Readonly<PolicyConfig> {
  /** SHA-256 over the canonical policy. Every decision records it. */
  readonly hash: string;
}

export interface PolicyDecision {
  outcome: 'blocked' | 'autonomous' | 'needs_human';
  reasons: string[];
  amountAtStakeUsd: number;
  eligibleRoles: string[];
  policyVersion: string;
  policyHash: string;
}

export interface DecisionInput {
  verb: string;
  amountAtStakeUsd: number;
  confidence: number;
  exceptionType: ExceptionType;
}

export class PolicyError extends Error {
  override name = 'PolicyError';
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`Policy rejected:\n  - ${problems.join('\n  - ')}`);
    this.problems = problems;
  }
}

/** Validate a policy document and return a frozen, fingerprinted Policy. */
export function loadPolicy(raw: unknown): Policy {
  const problems: string[] = [];
  const cfg = raw as PolicyConfig;
  if (!cfg || typeof cfg !== 'object') throw new PolicyError(['policy must be an object']);

  if (typeof cfg.version !== 'string' || !cfg.version) problems.push('version is required');
  if (!(cfg.confidenceFloor >= 0 && cfg.confidenceFloor <= 1)) problems.push('confidenceFloor must be between 0 and 1');

  const directory = cfg.directory ?? {};
  for (const [id, person] of Object.entries(directory)) {
    if (!isHumanId(id)) problems.push(`directory key ${id} is not a human identity (human:<email>)`);
    if (!person?.name || !person?.role) problems.push(`directory entry ${id} needs a name and a role`);
  }

  if (cfg.signedBy !== null) {
    if (!isHumanId(cfg.signedBy)) problems.push('signedBy must be a human identity or null');
    else if (!Object.hasOwn(directory, cfg.signedBy)) problems.push(`signedBy ${cfg.signedBy} is not in the directory`);
    if (!cfg.signedAt) problems.push('signedAt is required when signedBy is set');
  }

  for (const [name, rule] of Object.entries(cfg.verbs ?? {})) {
    if (!isVerb(name)) {
      problems.push(`verbs.${name} is not in the kernel vocabulary (${VERB_NAMES.join(', ')}); configuration cannot add verbs`);
      continue;
    }
    if (typeof rule?.enabled !== 'boolean') problems.push(`verbs.${name}.enabled must be true or false`);
    const limit = rule?.autonomousUpToUsd;
    if (limit !== null && !(typeof limit === 'number' && limit >= 0 && Number.isFinite(limit))) {
      problems.push(`verbs.${name}.autonomousUpToUsd must be a non-negative number or null`);
    }
    if (VERBS[name].kernelHumanOnly && limit !== null) {
      problems.push(`verbs.${name} is human-only by kernel rule; autonomousUpToUsd must be null`);
    }
  }

  const bands = cfg.approvalMatrix?.bands ?? [];
  if (!bands.length) problems.push('approvalMatrix.bands must not be empty');
  let previous = -1;
  bands.forEach((band, i) => {
    const isLast = i === bands.length - 1;
    if (band.upToUsd === null && !isLast) problems.push(`approvalMatrix.bands[${i}]: only the last band may be unbounded`);
    if (band.upToUsd !== null && !(band.upToUsd > previous)) problems.push(`approvalMatrix.bands[${i}]: upToUsd must increase`);
    if (isLast && band.upToUsd !== null) problems.push('approvalMatrix: the last band must be unbounded (upToUsd: null)');
    if (!band.roles?.length) problems.push(`approvalMatrix.bands[${i}]: roles must not be empty`);
    previous = band.upToUsd ?? previous;
  });
  for (const [type, roles] of Object.entries(cfg.approvalMatrix?.minimumRolesByException ?? {})) {
    if (!(EXCEPTION_TYPES as readonly string[]).includes(type)) problems.push(`minimumRolesByException.${type} is not an exception type`);
    if (!roles?.length) problems.push(`minimumRolesByException.${type} must not be empty`);
  }

  const s = cfg.screening;
  if (!s || !(s.priceTolerancePct >= 0) || !(s.qtyTolerancePct >= 0)) problems.push('screening tolerances must be non-negative numbers');

  if (problems.length) throw new PolicyError(problems);
  return deepFreeze({ ...structuredClone(cfg), hash: digest(cfg) }) as Policy;
}

/** Decide what happens to one proposed action. Pure function of its inputs. */
export function decide(policy: Policy, input: DecisionInput): PolicyDecision {
  const base = { amountAtStakeUsd: input.amountAtStakeUsd, policyVersion: policy.version, policyHash: policy.hash };

  if (!isVerb(input.verb)) {
    return { ...base, outcome: 'blocked', reasons: [`${input.verb} is not in the kernel vocabulary`], eligibleRoles: [] };
  }
  const verb: Verb = input.verb;
  const rule = policy.verbs[verb];
  if (!rule || !rule.enabled) {
    return { ...base, outcome: 'blocked', reasons: [`${verb} is not enabled in policy ${policy.version}`], eligibleRoles: [] };
  }

  const reasons: string[] = [];
  if (VERBS[verb].kernelHumanOnly) reasons.push(`${verb} is human-only by kernel rule`);
  if (policy.signedBy === null) reasons.push('policy is unsigned, so there is no standing approval');
  if (rule.autonomousUpToUsd === null) reasons.push(`policy requires a person for every ${verb}`);
  else if (input.amountAtStakeUsd > rule.autonomousUpToUsd) {
    reasons.push(`${usd(input.amountAtStakeUsd)} at stake exceeds the standing limit of ${usd(rule.autonomousUpToUsd)} for ${verb}`);
  }
  if (input.confidence < policy.confidenceFloor) {
    reasons.push(`confidence ${input.confidence.toFixed(2)} is below the floor of ${policy.confidenceFloor.toFixed(2)}`);
  }

  if (reasons.length) {
    return { ...base, outcome: 'needs_human', reasons, eligibleRoles: eligibleRoles(policy, input.amountAtStakeUsd, input.exceptionType) };
  }
  return {
    ...base,
    outcome: 'autonomous',
    reasons: [`within the standing approval signed by ${policy.signedBy} (policy ${policy.version})`],
    eligibleRoles: [],
  };
}

export function eligibleRoles(policy: Policy, amountUsd: number, exceptionType: ExceptionType): string[] {
  const bands = policy.approvalMatrix.bands;
  const band = bands.find((b) => b.upToUsd === null || amountUsd <= b.upToUsd) ?? bands[bands.length - 1]!;
  const minimum = policy.approvalMatrix.minimumRolesByException?.[exceptionType];
  return minimum ? band.roles.filter((r) => minimum.includes(r)) : [...band.roles];
}

export type ApproverCheck = { ok: true; approver: HumanId; person: Person } | { ok: false; reason: string };

/** May this identity approve an action that received this decision? */
export function checkApprover(policy: Policy, decision: PolicyDecision, identity: string): ApproverCheck {
  if (isAgentId(identity)) {
    return { ok: false, reason: `segregation of duties: ${identity} is an agent, and agents cannot approve actions` };
  }
  if (!isHumanId(identity)) return { ok: false, reason: `${identity} is not a human identity` };
  if (!Object.hasOwn(policy.directory, identity)) {
    return { ok: false, reason: `${identity} is not in the directory of policy ${policy.version}` };
  }
  const person = policy.directory[identity]!;
  if (decision.outcome !== 'needs_human') return { ok: false, reason: 'this action is not awaiting a human decision' };
  if (!decision.eligibleRoles.includes(person.role)) {
    return {
      ok: false,
      reason: `${person.name} (${person.role}) is not authorized for ${usd(decision.amountAtStakeUsd)}; requires one of: ${decision.eligibleRoles.join(', ')}`,
    };
  }
  return { ok: true, approver: identity, person };
}

/** Rejecting is the conservative choice, so any person in the directory may reject. */
export function checkRejecter(policy: Policy, identity: string): ApproverCheck {
  if (isAgentId(identity)) return { ok: false, reason: `segregation of duties: ${identity} is an agent` };
  if (!isHumanId(identity) || !Object.hasOwn(policy.directory, identity)) {
    return { ok: false, reason: `${identity} is not a person in the directory of policy ${policy.version}` };
  }
  return { ok: true, approver: identity, person: policy.directory[identity]! };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
