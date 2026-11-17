import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import prisma, { ExtendedPrismaClient } from '@/prisma/prisma.service';
import { Prisma, ReconciliationProject, ReconciliationCase } from '../../../prisma/generated/prisma/client';
import { FinancialReadService } from '../documents/settlement/financial-read.service';
import { lockReconciliationCompany, lockReconciliationProject } from './persistence';
import { parse, schemas, encodePeriod, decodePeriod } from './validation';
import { linkDocument, unlinkDocument } from './document-links';
import { loadReviewSnapshot, reviewCase, attestEvidenceCoverage } from './review';
import type {
  CreateProjectInput,
  UpdateProjectInput,
  CreateCaseInput,
  UpdateCaseInput,
  MutationContext,
  MutationResult,
  ProjectRecord,
  CaseRecord,
  LinkDocumentInput,
  EvidenceCoverageInput,
  ReviewCaseInput,
} from './types';

export const RECONCILIATION_DB = Symbol('RECONCILIATION_DB');
export function reconciliationHash(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canonical(x)]),
      );
    return v;
  }
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}
export function reconciliationConflict(message: string, code = 'RECONCILIATION_CHANGED'): never {
  throw new ConflictException({ code, message });
}
export const projectInclude = {
  endCustomer: { select: { id: true, name: true, isActive: true } },
  partner: { select: { id: true, name: true, isActive: true } },
  timeProject: { select: { id: true, name: true, isArchived: true } },
  _count: {
    select: {
      invoiceReferences: true,
      receipts: true,
      documentLinks: true,
      cases: {
        where: {
          OR: [
            { agreedGrossMinor: { not: null } },
            { agreedNetMinor: { not: null } },
            { agreedTaxMinor: { not: null } },
          ],
        },
      },
    },
  },
} satisfies Prisma.ReconciliationProjectInclude;
type ProjectWithLabels = Prisma.ReconciliationProjectGetPayload<{ include: typeof projectInclude }>;
function identityLocked(counts: ProjectWithLabels['_count']): boolean {
  return counts.invoiceReferences > 0 || counts.receipts > 0 || counts.documentLinks > 0 || counts.cases > 0;
}
export function projectRecord(row: ProjectWithLabels): ProjectRecord {
  const { revision, createdAt, updatedAt, endCustomer, partner, timeProject, _count, ...rest } = row;
  const client = (value: typeof endCustomer) =>
    value ? { id: value.id, name: value.name, inactive: !value.isActive } : null;
  return {
    ...rest,
    version: revision,
    identityLocked: identityLocked(_count),
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    endCustomerClient: client(endCustomer),
    partnerClient: client(partner),
    timeProject: timeProject
      ? { id: timeProject.id, name: timeProject.name, inactive: timeProject.isArchived }
      : null,
  };
}
export function caseRecord(row: ReconciliationCase): CaseRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    title: row.title,
    ...decodePeriod(row.period),
    status: row.status,
    version: row.version,
    agreedGrossMinor: row.agreedGrossMinor,
    agreedNetMinor: row.agreedNetMinor,
    agreedVatMinor: row.agreedTaxMinor,
    agreementReference: row.agreementReference,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
@Injectable()
export class ReconciliationService {
  constructor(
    readonly financialRead: FinancialReadService,
    @Optional() @Inject(RECONCILIATION_DB) readonly db: ExtendedPrismaClient = prisma,
  ) {}

  async sourceVersion(tx: Prisma.TransactionClient, companyId: string, project: ReconciliationProject) {
    const links = await tx.projectDocumentLink.findMany({
      where: { companyId, projectId: project.id },
      include: { document: { select: { typeId: true } } },
      orderBy: { documentId: 'asc' },
    });
    const refs = links.map((link) => ({
      id: link.documentId,
      typeId: link.document.typeId as 'invoice' | 'expense' | 'received-invoice',
    }));
    try {
      const reads = await this.financialRead.readMany(companyId, refs, tx);
      const fingerprint = reconciliationHash(
        [...reads].map(([key, value]) => [key, value.sourceVersion]).sort(([a], [b]) => a.localeCompare(b)),
      );
      return { sourceFingerprint: fingerprint, versionToken: `${project.revision}:${fingerprint}` };
    } catch {
      throw new ServiceUnavailableException({
        code: 'FINANCIAL_READ_UNAVAILABLE',
        message: 'Canonical financial sources could not be read.',
      });
    }
  }

  // Defer read composition to avoid service → views → T4 mappers → service DI metadata recursion.
  async listProjects(companyId: string, query: unknown = {}) {
    return (await import('./project-view.js')).listProjectViews(
      companyId,
      query,
      this.db,
      this.financialRead,
    );
  }
  async getProject(companyId: string, projectId: string, query: unknown = {}) {
    return (await import('./project-view.js')).readProjectView(
      companyId,
      projectId,
      query,
      this.db,
      this.financialRead,
    );
  }
  async listReceipts(companyId: string, projectId: string, query: unknown = {}) {
    return (await import('./project-view.js')).listReceiptViews(companyId, projectId, query, this.db);
  }
  async listCustomerInvoices(companyId: string, projectId: string, query: unknown = {}) {
    return (await import('./project-view.js')).listCustomerInvoiceViews(
      companyId,
      projectId,
      query,
      this.db,
      this.financialRead,
    );
  }
  async listHistory(companyId: string, projectId: string, query: unknown = {}) {
    return (await import('./project-view.js')).listProjectHistory(companyId, projectId, query, this.db);
  }
  async exportProject(companyId: string, projectId: string, query: unknown = {}) {
    return (await import('./project-view.js')).exportProjectCsv(
      companyId,
      projectId,
      query,
      this.db,
      this.financialRead,
    );
  }

  /** All feature writes use this envelope; retry data lives outside the source version fingerprint. */
  async mutate<T>(
    companyId: string,
    projectId: string | null,
    input: unknown,
    context: MutationContext,
    operation: string,
    target: string,
    apply: (
      tx: Prisma.TransactionClient,
      project: ReconciliationProject | null,
    ) => Promise<{ result: T; projectId: string; before?: unknown; auditReason?: string }>,
    checkTarget?: (tx: Prisma.TransactionClient) => Promise<void>,
    candidateDocumentIds:
      | readonly string[]
      | ((tx: Prisma.TransactionClient, project: ReconciliationProject) => Promise<readonly string[]>) = [],
    options: { exclusiveCompany?: boolean; staleCode?: string } = {},
  ): Promise<MutationResult<T>> {
    const { requestKey, expectedVersion } = parse(schemas.envelope, {
      requestKey: context.requestKey,
      expectedVersion: context.expectedVersion,
    });
    if (!context.actor.id || !['user', 'api-key'].includes(context.actor.kind))
      throw new Error('Authenticated actor is required');
    const actor = `${context.actor.kind}:${context.actor.id}`;
    const payloadHash = reconciliationHash({ operation, projectId, target, input });
    return this.db
      .$transaction(async (tx) => {
        if (!(await lockReconciliationCompany(tx, companyId, options.exclusiveCompany)).length)
          throw new NotFoundException({ code: 'NOT_FOUND', message: 'Company not found.' });
        // Serialise retries even for creates, where the aggregate row does not exist yet.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([companyId, actor, requestKey])}, 0))::text`;
        const prior = await tx.reconciliationAuditEvent.findUnique({
          where: { companyId_actor_requestKey: { companyId, actor, requestKey } },
        });
        if (prior) {
          const before = prior.before as { payloadHash?: string } | null;
          if (before?.payloadHash !== payloadHash)
            reconciliationConflict('This request key was already used for a different operation.');
          const saved = prior.after as unknown as MutationResult<T>;
          return { ...saved, changed: false };
        }
        let project: ReconciliationProject | null = null;
        if (projectId) {
          if (!(await lockReconciliationProject(tx, companyId, projectId)).length)
            throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project not found.' });
          project = await tx.reconciliationProject.findFirstOrThrow({ where: { companyId, id: projectId } });
          await checkTarget?.(tx);
          const links = await tx.projectDocumentLink.findMany({
            where: { companyId, projectId },
            select: { documentId: true },
            orderBy: { documentId: 'asc' },
          });
          const sourceIds = [
            ...new Set([
              ...links.map((link) => link.documentId),
              ...(typeof candidateDocumentIds === 'function'
                ? await candidateDocumentIds(tx, project)
                : candidateDocumentIds),
            ]),
          ].sort();
          for (const id of sourceIds)
            await tx.$queryRaw`SELECT id FROM "DocumentInstance" WHERE "companyId"=${companyId} AND id=${id} FOR UPDATE`;
          if ((await this.sourceVersion(tx, companyId, project)).versionToken !== expectedVersion)
            reconciliationConflict(
              'The project or its financial sources changed. Refresh before retrying.',
              options.staleCode,
            );
        } else if (expectedVersion !== 'new')
          reconciliationConflict('Project creation requires expectedVersion new.');
        const change = await apply(tx, project);
        const reopenedCases: ReconciliationCase[] = [];
        if (
          projectId &&
          (await tx.reconciliationCase.count({ where: { companyId, projectId, status: { not: 'OPEN' } } }))
        ) {
          const snapshot = await loadReviewSnapshot(tx, companyId, project!, this.financialRead);
          for (const row of snapshot.cases)
            if (row.status !== 'OPEN' && row.reviewedSourceFingerprint !== snapshot.fingerprint) {
              if (operation === 'case.review' && target === `case:${row.id}`)
                reconciliationConflict('Financial sources changed during review. Refresh before retrying.');
              reopenedCases.push(row);
              await tx.reconciliationCase.update({
                where: { id: row.id },
                data: {
                  status: 'OPEN',
                  reviewedSourceFingerprint: null,
                  reviewedAt: null,
                  reviewedBy: null,
                  version: { increment: 1 },
                },
              });
            }
        }
        if (projectId)
          await tx.reconciliationProject.update({
            where: { companyId_id: { companyId, id: projectId } },
            data: { revision: { increment: 1 } },
          });
        const updated = await tx.reconciliationProject.findFirstOrThrow({
          where: { companyId, id: change.projectId },
        });
        // Project mutations return the new aggregate revision, including for edits to the project itself.
        let result = change.result;
        if (operation.startsWith('project.'))
          result = projectRecord(
            await tx.reconciliationProject.findFirstOrThrow({
              where: { companyId, id: change.projectId },
              include: projectInclude,
            }),
          ) as T;
        const response = {
          result,
          versionToken: (await this.sourceVersion(tx, companyId, updated)).versionToken,
          changed: true,
        };
        await tx.reconciliationAuditEvent.create({
          data: {
            companyId,
            projectId: change.projectId,
            actor,
            operation,
            requestKey,
            affectedRecord: target === 'new' ? `project:${change.projectId}` : target,
            before: JSON.parse(
              JSON.stringify({
                payloadHash,
                state: change.before ?? null,
                ...(reopenedCases.length ? { reopenedCases } : {}),
              }),
            ),
            reason: change.auditReason,
            after: JSON.parse(JSON.stringify(response)),
          },
        });
        return response;
      })
      .catch((error) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2003'].includes(error.code))
          reconciliationConflict('An association changed or is already in use. Refresh before retrying.');
        throw error;
      });
  }
  async previewImport(
    companyId: string,
    projectId: string,
    input: unknown,
  ): Promise<import('./types').ImportPreview> {
    // Importer reuses ExternalReceiptsService helpers, whose injected core must initialize first.
    return (await import('./import.js')).previewImport(this, companyId, projectId, input);
  }
  async confirmImport(
    companyId: string,
    projectId: string,
    input: unknown,
    context: MutationContext,
  ): Promise<import('./types').ImportResult> {
    return (await import('./import.js')).confirmImport(this, companyId, projectId, input, context);
  }
  linkDocument(companyId: string, projectId: string, input: LinkDocumentInput, context: MutationContext) {
    return linkDocument(this, companyId, projectId, input, context);
  }
  unlinkDocument(
    companyId: string,
    projectId: string,
    input: { linkId: string; reason: string },
    context: MutationContext,
  ) {
    return unlinkDocument(this, companyId, projectId, input, context);
  }
  reviewCase(
    companyId: string,
    projectId: string,
    input: ReviewCaseInput & { caseId: string },
    context: MutationContext,
  ) {
    return reviewCase(this, companyId, projectId, input, context);
  }
  attestEvidenceCoverage(
    companyId: string,
    projectId: string,
    input: EvidenceCoverageInput,
    context: MutationContext,
  ) {
    return attestEvidenceCoverage(this, companyId, projectId, input, context);
  }
  private async associations(
    tx: Prisma.TransactionClient,
    companyId: string,
    input: CreateProjectInput,
    previous?: ReconciliationProject,
  ) {
    for (const field of ['endCustomerClientId', 'partnerClientId'] as const) {
      const id = input[field];
      if (
        id &&
        id !== previous?.[field] &&
        !(await tx.client.findFirst({ where: { companyId, id, isActive: true } }))
      )
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Active client not found.' });
    }
    if (input.timeProjectId && input.timeProjectId !== previous?.timeProjectId) {
      if (!(await tx.project.findFirst({ where: { companyId, id: input.timeProjectId, isArchived: false } })))
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Available time project not found.' });
      if (
        await tx.reconciliationProject.findFirst({
          where: {
            companyId,
            timeProjectId: input.timeProjectId,
            ...(previous ? { id: { not: previous.id } } : {}),
          },
        })
      )
        reconciliationConflict('This time project is already associated.');
    }
  }
  async createProject(companyId: string, input: CreateProjectInput, context: MutationContext) {
    const data = parse(schemas.createProject, input);
    return this.mutate(companyId, null, data, context, 'project.create', 'new', async (tx) => {
      await this.associations(tx, companyId, data);
      const project = await tx.reconciliationProject.create({
        data: { companyId, ...data },
        include: projectInclude,
      });
      return { result: projectRecord(project), projectId: project.id };
    });
  }
  async updateProject(
    companyId: string,
    projectId: string,
    input: UpdateProjectInput,
    context: MutationContext,
  ) {
    const patch = parse(schemas.updateProject, input);
    return this.mutate(
      companyId,
      projectId,
      patch,
      context,
      'project.update',
      `project:${projectId}`,
      async (tx, project) => {
        const merged = parse(
          schemas.createProject,
          Object.fromEntries(
            Object.keys(schemas.createProject.shape).map((key) => [
              key,
              patch[key] !== undefined ? patch[key] : project![key],
            ]),
          ),
        );
        const identityChanged = ['currency', 'collectionMode', 'endCustomerClientId', 'partnerClientId'].some(
          (key) => merged[key] !== project![key],
        );
        if (identityChanged) {
          const state = await tx.reconciliationProject.findFirstOrThrow({
            where: { companyId, id: projectId },
            include: projectInclude,
          });
          if (identityLocked(state._count))
            reconciliationConflict(
              'Currency, direction and party identity are locked by financial references or agreements.',
            );
        }
        await this.associations(tx, companyId, merged, project!);
        const result = await tx.reconciliationProject.update({
          where: { companyId_id: { companyId, id: projectId } },
          data: patch,
          include: projectInclude,
        });
        return { result: projectRecord(result), projectId, before: project };
      },
    );
  }
  async createCase(companyId: string, projectId: string, input: CreateCaseInput, context: MutationContext) {
    const data = parse(schemas.createCase, input);
    return this.mutate(
      companyId,
      projectId,
      data,
      context,
      'case.create',
      `project:${projectId}`,
      async (tx, project) => {
        const row = await this.createCaseTx(tx, project!, data);
        return { result: caseRecord(row), projectId };
      },
    );
  }
  async updateCase(
    companyId: string,
    projectId: string,
    caseId: string,
    input: UpdateCaseInput,
    context: MutationContext,
  ) {
    const patch = parse(schemas.updateCase, input);
    return this.mutate(
      companyId,
      projectId,
      { caseId, ...patch },
      context,
      'case.update',
      `case:${caseId}`,
      async (tx, project) => {
        const row = await tx.reconciliationCase.findFirst({ where: { companyId, projectId, id: caseId } });
        if (!row) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Case not found.' });
        const current = caseRecord(row);
        const merged = parse(
          schemas.createCase,
          Object.fromEntries(
            Object.keys(schemas.createCase.shape).map((key) => [
              key,
              patch[key] !== undefined ? patch[key] : current[key],
            ]),
          ),
        );
        this.checkAgreement(project!, merged);
        const { periodStart, periodEnd, agreedVatMinor, ...rest } = merged;
        const updated = await tx.reconciliationCase.update({
          where: { id: row.id },
          data: {
            ...rest,
            period: encodePeriod(periodStart, periodEnd),
            agreedTaxMinor: agreedVatMinor,
            version: { increment: 1 },
            status: 'OPEN',
            reviewedAt: null,
            reviewedBy: null,
            reviewedSourceFingerprint: null,
          },
        });
        return { result: caseRecord(updated), projectId, before: current };
      },
      async (tx) => {
        if (
          !(await tx.reconciliationCase.findFirst({
            where: { companyId, projectId, id: caseId },
            select: { id: true },
          }))
        )
          throw new NotFoundException({ code: 'NOT_FOUND', message: 'Case not found.' });
      },
    );
  }
  async createCaseTx(
    tx: Prisma.TransactionClient,
    project: ReconciliationProject,
    input: CreateCaseInput,
  ): Promise<ReconciliationCase> {
    const data = parse(schemas.createCase, input);
    this.checkAgreement(project, data);
    const { periodStart, periodEnd, agreedVatMinor, ...rest } = data;
    return tx.reconciliationCase.create({
      data: {
        companyId: project.companyId,
        projectId: project.id,
        ...rest,
        period: encodePeriod(periodStart, periodEnd),
        agreedTaxMinor: agreedVatMinor,
      },
    });
  }
  checkAgreement(
    project: ReconciliationProject,
    input: CreateCaseInput & { agreementReason?: string | null },
  ) {
    if (
      !project.partnerClientId &&
      [
        input.agreedGrossMinor,
        input.agreedNetMinor,
        input.agreedVatMinor,
        input.agreementReference,
        input.agreementReason,
      ].some((value) => value != null)
    )
      reconciliationConflict('A settlement agreement requires a partner client.');
  }
}
