import { randomUUID } from "node:crypto";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db } from "./db/client.js";
import { biometricResearchProposals, biometricReviewDecisions } from "./db/schema.js";

type ProposalStatus = "draft" | "submitted" | "approved" | "rejected";
type ReviewType = "ethics" | "legal";
type ReviewDecision = "approved" | "rejected";

const REVIEW_TYPES: ReviewType[] = ["ethics", "legal"];

function now(): number {
  return Date.now();
}

function strictlyIncreasingTimestamp(previous: number): number {
  const candidate = now();
  return candidate > previous ? candidate : previous + 1;
}

function asProposalStatus(value: string): ProposalStatus {
  if (value === "draft" || value === "submitted" || value === "approved" || value === "rejected") {
    return value;
  }
  throw new Error(`invalid proposal status in storage: ${value}`);
}

function asReviewType(value: string): ReviewType {
  if (value === "ethics" || value === "legal") {
    return value;
  }
  throw new Error("review_type must be ethics|legal");
}

function asReviewDecision(value: string): ReviewDecision {
  if (value === "approved" || value === "rejected") {
    return value;
  }
  throw new Error("decision must be approved|rejected");
}

export type BiometricGovernanceReview = {
  id: string;
  proposal_id: string;
  review_type: ReviewType;
  decision: ReviewDecision;
  reviewer: string;
  rationale: string | null;
  created_at: number;
};

export type BiometricGovernanceProposal = {
  id: string;
  title: string;
  purpose: string;
  requested_by: string;
  notes: string | null;
  status: ProposalStatus;
  created_at: number;
  updated_at: number;
  reviews: BiometricGovernanceReview[];
};

function serializeReview(row: typeof biometricReviewDecisions.$inferSelect): BiometricGovernanceReview {
  return {
    id: row.id,
    proposal_id: row.proposalId,
    review_type: asReviewType(row.reviewType),
    decision: asReviewDecision(row.decision),
    reviewer: row.reviewer,
    rationale: row.rationale,
    created_at: row.createdAt,
  };
}

function serializeProposal(
  row: typeof biometricResearchProposals.$inferSelect,
  reviews: BiometricGovernanceReview[],
): BiometricGovernanceProposal {
  return {
    id: row.id,
    title: row.title,
    purpose: row.purpose,
    requested_by: row.requestedBy,
    notes: row.notes,
    status: asProposalStatus(row.status),
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    reviews,
  };
}

async function reviewsByProposalIds(proposalIds: string[]): Promise<Map<string, BiometricGovernanceReview[]>> {
  const byProposal = new Map<string, BiometricGovernanceReview[]>();
  if (proposalIds.length === 0) return byProposal;
  const rows = await db
    .select()
    .from(biometricReviewDecisions)
    .where(inArray(biometricReviewDecisions.proposalId, proposalIds))
    .orderBy(asc(biometricReviewDecisions.createdAt))
    .all();
  for (const row of rows) {
    const serialized = serializeReview(row);
    const list = byProposal.get(row.proposalId);
    if (list) {
      list.push(serialized);
    } else {
      byProposal.set(row.proposalId, [serialized]);
    }
  }
  return byProposal;
}

function normalizedNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} required`);
  return normalized;
}

export async function createBiometricGovernanceProposal(input: {
  title: string;
  purpose: string;
  requestedBy: string;
  notes?: string;
}): Promise<BiometricGovernanceProposal> {
  const title = normalizedNonEmpty(input.title, "title");
  const purpose = normalizedNonEmpty(input.purpose, "purpose");
  const requestedBy = normalizedNonEmpty(input.requestedBy, "requested_by");
  const notes = input.notes?.trim() ? input.notes.trim() : null;
  const ts = now();
  const id = randomUUID();
  await db.insert(biometricResearchProposals).values({
    id,
    title,
    purpose,
    requestedBy,
    notes,
    status: "draft",
    createdAt: ts,
    updatedAt: ts,
  });
  return {
    id,
    title,
    purpose,
    requested_by: requestedBy,
    notes,
    status: "draft",
    created_at: ts,
    updated_at: ts,
    reviews: [],
  };
}

export async function listBiometricGovernanceProposals(): Promise<{ proposals: BiometricGovernanceProposal[] }> {
  const proposals = await db
    .select()
    .from(biometricResearchProposals)
    .orderBy(desc(biometricResearchProposals.updatedAt), desc(biometricResearchProposals.createdAt))
    .all();
  const proposalIds = proposals.map((proposal) => proposal.id);
  const reviews = await reviewsByProposalIds(proposalIds);
  return {
    proposals: proposals.map((proposal) => serializeProposal(proposal, reviews.get(proposal.id) ?? [])),
  };
}

export async function getBiometricGovernanceProposalById(id: string): Promise<BiometricGovernanceProposal | null> {
  const proposal = await db.select().from(biometricResearchProposals).where(eq(biometricResearchProposals.id, id)).get();
  if (!proposal) return null;
  const reviews = await reviewsByProposalIds([proposal.id]);
  return serializeProposal(proposal, reviews.get(proposal.id) ?? []);
}

export async function submitBiometricGovernanceProposal(id: string): Promise<BiometricGovernanceProposal> {
  const proposal = await db.select().from(biometricResearchProposals).where(eq(biometricResearchProposals.id, id)).get();
  if (!proposal) throw new Error("proposal not found");
  if (proposal.status !== "draft") throw new Error("proposal must be in draft status to submit");
  const updatedAt = strictlyIncreasingTimestamp(proposal.updatedAt);
  await db
    .update(biometricResearchProposals)
    .set({
      status: "submitted",
      updatedAt,
    })
    .where(eq(biometricResearchProposals.id, id));
  const updated = await getBiometricGovernanceProposalById(id);
  if (!updated) throw new Error("proposal not found");
  return updated;
}

export async function addBiometricGovernanceReview(input: {
  proposalId: string;
  reviewType: string;
  decision: string;
  reviewer: string;
  rationale?: string;
}): Promise<BiometricGovernanceProposal> {
  const proposalId = input.proposalId;
  const reviewType = asReviewType(input.reviewType);
  const decision = asReviewDecision(input.decision);
  const reviewer = normalizedNonEmpty(input.reviewer, "reviewer");
  const rationale = input.rationale?.trim() ? input.rationale.trim() : null;

  const proposal = await db.select().from(biometricResearchProposals).where(eq(biometricResearchProposals.id, proposalId)).get();
  if (!proposal) throw new Error("proposal not found");
  if (proposal.status !== "submitted") {
    throw new Error("reviews are only allowed for submitted proposals");
  }

  const existingDecision = await db
    .select()
    .from(biometricReviewDecisions)
    .where(and(eq(biometricReviewDecisions.proposalId, proposalId), eq(biometricReviewDecisions.reviewType, reviewType)))
    .get();
  if (existingDecision) {
    throw new Error("review decision already recorded for this review_type");
  }

  await db.insert(biometricReviewDecisions).values({
    id: randomUUID(),
    proposalId,
    reviewType,
    decision,
    reviewer,
    rationale,
    createdAt: now(),
  });

  const allDecisions = await db
    .select()
    .from(biometricReviewDecisions)
    .where(eq(biometricReviewDecisions.proposalId, proposalId))
    .all();

  let nextStatus: ProposalStatus = "submitted";
  if (allDecisions.some((row) => row.decision === "rejected")) {
    nextStatus = "rejected";
  } else {
    const approvedTypes = new Set<ReviewType>(
      allDecisions.filter((row) => row.decision === "approved").map((row) => asReviewType(row.reviewType)),
    );
    if (REVIEW_TYPES.every((type) => approvedTypes.has(type))) {
      nextStatus = "approved";
    }
  }

  const updatedAt = strictlyIncreasingTimestamp(proposal.updatedAt);
  await db
    .update(biometricResearchProposals)
    .set({
      status: nextStatus,
      updatedAt,
    })
    .where(eq(biometricResearchProposals.id, proposalId));

  const updated = await getBiometricGovernanceProposalById(proposalId);
  if (!updated) throw new Error("proposal not found");
  return updated;
}

export async function getBiometricGovernanceStatus(input: {
  biometricResearchEnabled: boolean;
}): Promise<{
  biometric_research_enabled: boolean;
  has_approved_proposal: boolean;
  approved_proposal_id: string | null;
  biometric_ingestion_allowed: boolean;
  checked_at: number;
}> {
  const approvedProposal = await db
    .select({
      id: biometricResearchProposals.id,
    })
    .from(biometricResearchProposals)
    .where(eq(biometricResearchProposals.status, "approved"))
    .orderBy(desc(biometricResearchProposals.updatedAt), desc(biometricResearchProposals.createdAt))
    .get();

  const hasApprovedProposal = !!approvedProposal?.id;
  return {
    biometric_research_enabled: input.biometricResearchEnabled,
    has_approved_proposal: hasApprovedProposal,
    approved_proposal_id: approvedProposal?.id ?? null,
    biometric_ingestion_allowed: input.biometricResearchEnabled && hasApprovedProposal,
    checked_at: now(),
  };
}
