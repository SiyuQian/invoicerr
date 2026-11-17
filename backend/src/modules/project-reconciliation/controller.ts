import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { ActiveCompany } from '@/decorators/active-company.decorator';
import { Roles } from '@/decorators/roles.decorator';
import { RequestWithUser } from '@/types/request';
import { RequiresScope } from '@/utils/scope-check';
import { CompanyRole } from '../../../prisma/generated/prisma/client';
import { ReconciliationAccessGuard } from './access.guard';
import { ReconciliationService } from './service';
import { ExternalReceiptsService } from './external-receipts';
import { assertImportSize, parseMutation, schemas } from './validation';
import { MutationContext } from './types';

const wireSchema = (schema: z.ZodType) => {
  const input = z.toJSONSchema(schema, { target: 'openapi-3.0' });
  const envelope = z.toJSONSchema(schemas.envelope, { target: 'openapi-3.0' });
  return {
    type: 'object' as const,
    additionalProperties: false,
    properties: { ...input.properties, ...envelope.properties },
    required: [...(input.required ?? []), ...(envelope.required ?? [])],
  } as Extract<Parameters<typeof ApiBody>[0], { schema: unknown }>['schema'];
};
function responseSchema(schema: z.ZodType) {
  return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as Extract<
    Parameters<typeof ApiBody>[0],
    { schema: unknown }
  >['schema'];
}
const mutationResponse = (schema: z.ZodType) =>
  responseSchema(z.strictObject({ result: schema, versionToken: z.string(), changed: z.boolean() }));
function mutation<T>(schema: z.ZodType<T>, body: unknown, request: RequestWithUser) {
  const parsed = parseMutation(schema, body);
  const context: MutationContext = {
    actor: { id: request.user.id, kind: request.scopes === null ? 'user' : 'api-key' },
    requestKey: parsed.requestKey,
    expectedVersion: parsed.expectedVersion,
  };
  return { input: parsed.input, context };
}
@ApiTags('project-reconciliation')
@Controller('project-reconciliation')
@UseGuards(ReconciliationAccessGuard)
@Roles(CompanyRole.OWNER, CompanyRole.ADMIN, CompanyRole.MEMBER)
export class ReconciliationController {
  constructor(
    private readonly service: ReconciliationService,
    private readonly external: ExternalReceiptsService,
  ) {}
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['ACTIVE', 'ARCHIVED', 'ALL'] })
  @ApiQuery({ name: 'collectionMode', required: false, enum: ['COMPANY', 'PARTNER'] })
  @ApiQuery({ name: 'needsAttention', required: false, enum: ['true', 'false'] })
  @Get('projects')
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiOperation({ summary: 'List reconciled projects with lifetime measures' })
  @ApiResponse({
    status: 200,
    description: 'Page<ProjectListRow>',
    schema: responseSchema(schemas.projectListPage),
  })
  list(@ActiveCompany() companyId: string, @Query() query: unknown) {
    return this.service.listProjects(companyId, query);
  }
  @ApiQuery({
    name: 'invoiceFrom',
    required: false,
    type: String,
    description: 'Inclusive civil YYYY-MM-DD source date',
  })
  @ApiQuery({ name: 'invoiceTo', required: false, type: String })
  @ApiQuery({
    name: 'cashFrom',
    required: false,
    type: String,
    description: 'Inclusive YYYY-MM-DD actual cash date (canonical timestamps use UTC)',
  })
  @ApiQuery({ name: 'cashTo', required: false, type: String })
  @ApiQuery({
    name: 'caseId',
    required: false,
    type: String,
    description: 'Exact case target, mutually exclusive with cursor; root measures and version remain global',
  })
  @Get('projects/:id')
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiOperation({
    summary: 'Read a snapshot report with paged cases and independent invoice/cash date filters',
  })
  @ApiResponse({
    status: 200,
    description: 'ProjectView; balances/review remain overall; invoice and cash measures may be in period',
    schema: responseSchema(schemas.projectView),
  })
  detail(@ActiveCompany() companyId: string, @Param('id') id: string, @Query() query: unknown) {
    return this.service.getProject(companyId, id, query);
  }
  @ApiQuery({
    name: 'receiptId',
    required: false,
    type: String,
    description: 'Exact receipt target, mutually exclusive with cursor; allocation capacity remains global',
  })
  @Get('projects/:id/receipts')
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiOperation({ summary: 'Read paged active/voided receipts with global allocation context' })
  @ApiResponse({ status: 200, schema: responseSchema(schemas.receiptPage) })
  receipts(@ActiveCompany() companyId: string, @Param('id') id: string, @Query() query: unknown) {
    return this.service.listReceipts(companyId, id, query);
  }
  @Get('projects/:id/customer-invoices')
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiOperation({ summary: 'Read project-wide external invoice allocation choices across all cases' })
  @ApiResponse({ status: 200, schema: responseSchema(schemas.externalInvoicePage) })
  customerInvoices(@ActiveCompany() companyId: string, @Param('id') id: string, @Query() query: unknown) {
    return this.service.listCustomerInvoices(companyId, id, query);
  }
  @Get('projects/:id/history')
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'limit', required: false, type: Number, minimum: 1, maximum: 100 })
  @ApiOperation({ summary: 'Read immutable history ordered by occurredAt and id descending' })
  @ApiResponse({ status: 200, schema: responseSchema(schemas.historyPage) })
  history(@ActiveCompany() companyId: string, @Param('id') id: string, @Query() query: unknown) {
    return this.service.listHistory(companyId, id, query);
  }
  @Get('projects/:id/export.csv')
  @ApiQuery({ name: 'invoiceFrom', required: false, type: String })
  @ApiQuery({ name: 'invoiceTo', required: false, type: String })
  @ApiQuery({ name: 'cashFrom', required: false, type: String })
  @ApiQuery({ name: 'cashTo', required: false, type: String })
  @ApiOperation({ summary: 'Export every case using the detail report date filters in one snapshot' })
  @ApiResponse({ status: 200, content: { 'text/csv': { schema: { type: 'string' } } } })
  async export(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() response: Response,
  ) {
    const csv = await this.service.exportProject(companyId, id, query);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader('Content-Disposition', 'attachment; filename="project-reconciliation.csv"');
    response.status(200).send(csv);
  }
  @Post('projects')
  @RequiresScope('project-reconciliation:write')
  @ApiResponse({
    status: 200,
    description: 'Idempotent retry',
    schema: mutationResponse(schemas.projectRecord),
  })
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Create a reconciliation project',
    description: 'expectedVersion must be new. Authenticated actor and company are never body fields.',
  })
  @ApiBody({ schema: wireSchema(schemas.createProject) })
  @ApiResponse({
    status: 201,
    description: 'MutationResult<ProjectRecord>; retry returns 200 and changed=false',
    schema: mutationResponse(schemas.projectRecord),
  })
  async create(
    @ActiveCompany() companyId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.createProject, body, request);
    const result = await this.service.createProject(companyId, input, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Patch('projects/:id')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Edit or archive a reconciliation project',
    description: 'Set status=ARCHIVED to archive; this does not mark balances paid.',
  })
  @ApiBody({ schema: wireSchema(schemas.updateProject) })
  @ApiResponse({
    status: 200,
    description: 'MutationResult<ProjectRecord>',
    schema: mutationResponse(schemas.projectRecord),
  })
  update(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
  ) {
    const { input, context } = mutation(schemas.updateProject, body, request);
    return this.service.updateProject(companyId, id, input, context);
  }
  @Post('projects/:id/cases')
  @RequiresScope('project-reconciliation:write')
  @ApiResponse({ status: 200, description: 'Idempotent retry', schema: mutationResponse(schemas.caseRecord) })
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({ summary: 'Create a reconciliation case with nullable explicit agreement amounts' })
  @ApiBody({ schema: wireSchema(schemas.createCase) })
  @ApiResponse({
    status: 201,
    description: 'MutationResult<CaseRecord>; retry returns 200 and changed=false',
    schema: mutationResponse(schemas.caseRecord),
  })
  async createCase(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.createCase, body, request);
    const result = await this.service.createCase(companyId, id, input, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Patch('projects/:id/cases/:caseId')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Edit case metadata or explicit agreement',
    description: 'Omitted fields are retained; period order is checked after merging.',
  })
  @ApiBody({ schema: wireSchema(schemas.updateCase) })
  @ApiResponse({
    status: 200,
    description: 'MutationResult<CaseRecord>',
    schema: mutationResponse(schemas.caseRecord),
  })
  updateCase(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
  ) {
    const { input, context } = mutation(schemas.updateCase, body, request);
    return this.service.updateCase(companyId, id, caseId, input, context);
  }
  @Post('projects/:id/cases/:caseId/customer-invoices')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({ summary: 'Record an external customer invoice reference; source Paid is not cash' })
  @ApiBody({ schema: wireSchema(schemas.externalInvoice) })
  @ApiResponse({
    status: 201,
    description: 'MutationResult<ExternalInvoiceRecord>',
    schema: mutationResponse(schemas.externalInvoiceRecord),
  })
  @ApiResponse({
    status: 200,
    description: 'Idempotent retry',
    schema: mutationResponse(schemas.externalInvoiceRecord),
  })
  async saveExternalInvoice(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.externalInvoice, body, request);
    const result = await this.external.saveExternalInvoice(companyId, id, { caseId, ...input }, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Patch('projects/:id/cases/:caseId/customer-invoices/:invoiceId')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({ summary: 'Correct external invoice metadata; gross is fixed after a credit' })
  @ApiBody({ schema: wireSchema(schemas.updateExternalInvoice) })
  @ApiResponse({
    status: 200,
    description: 'MutationResult<ExternalInvoiceRecord>',
    schema: mutationResponse(schemas.externalInvoiceRecord),
  })
  updateExternalInvoice(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
  ) {
    const { input, context } = mutation(schemas.updateExternalInvoice, body, request);
    return this.external.saveExternalInvoice(companyId, id, { caseId, invoiceId, ...input }, context);
  }
  @Post('projects/:id/receipts')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Record external collection evidence, with nullable receipt date',
    description:
      'EVIDENCE_CHECKED requires explicit attested:true and evidenceReference; reported evidence is never promoted implicitly.',
  })
  @ApiBody({ schema: wireSchema(schemas.receipt) })
  @ApiResponse({
    status: 201,
    description: 'MutationResult<ReceiptRecord>',
    schema: mutationResponse(schemas.receiptRecord),
  })
  @ApiResponse({
    status: 200,
    description: 'Idempotent retry',
    schema: mutationResponse(schemas.receiptRecord),
  })
  async recordExternalReceipt(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.receipt, body, request);
    const result = await this.external.recordExternalReceipt(companyId, id, input, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Patch('projects/:id/receipts/:receiptId')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Correct receipt facts or evidence in place',
    description:
      'Every update resulting in EVIDENCE_CHECKED requires explicit attested:true on this request, including date or reason changes.',
  })
  @ApiBody({ schema: wireSchema(schemas.updateReceipt) })
  @ApiResponse({
    status: 200,
    description: 'MutationResult<ReceiptRecord>',
    schema: mutationResponse(schemas.receiptRecord),
  })
  updateExternalReceipt(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('receiptId') receiptId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
  ) {
    const { input, context } = mutation(schemas.updateReceipt, body, request);
    return this.external.updateExternalReceipt(companyId, id, { receiptId, ...input }, context);
  }
  @Put('projects/:id/receipts/:receiptId/allocations')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Atomically replace the complete allocation set; empty array reverses all allocations',
  })
  @ApiBody({ schema: wireSchema(schemas.allocations) })
  @ApiResponse({
    status: 200,
    description: 'MutationResult<ReceiptAllocationsRecord>',
    schema: mutationResponse(schemas.receiptAllocationsRecord),
  })
  replaceReceiptAllocations(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('receiptId') receiptId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
  ) {
    const { input, context } = mutation(schemas.allocations, body, request);
    return this.external.replaceReceiptAllocations(companyId, id, { receiptId, ...input }, context);
  }
  @Post('projects/:id/receipts/:receiptId/void')
  @RequiresScope('project-reconciliation:write')
  @HttpCode(200)
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Void evidence and release allocations while retaining receipt and audit history',
  })
  @ApiBody({ schema: wireSchema(schemas.reason) })
  @ApiResponse({
    status: 200,
    description: 'MutationResult<ReceiptRecord>',
    schema: mutationResponse(schemas.receiptRecord),
  })
  voidExternalReceipt(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('receiptId') receiptId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
  ) {
    const { input, context } = mutation(schemas.reason, body, request);
    return this.external.voidExternalReceipt(companyId, id, { receiptId, ...input }, context);
  }
  @Post('projects/:id/customer-invoices/:invoiceId/credit-adjustments')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({ summary: 'Apply a positive external credit adjustment without rewriting original gross' })
  @ApiBody({ schema: wireSchema(schemas.creditAdjustment) })
  @ApiResponse({
    status: 201,
    description: 'MutationResult<ExternalInvoiceRecord>',
    schema: mutationResponse(schemas.externalInvoiceRecord),
  })
  @ApiResponse({
    status: 200,
    description: 'Idempotent retry',
    schema: mutationResponse(schemas.externalInvoiceRecord),
  })
  async applyExternalCreditAdjustment(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('invoiceId') invoiceId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.creditAdjustment, body, request);
    const result = await this.external.applyExternalCreditAdjustment(
      companyId,
      id,
      { invoiceId, ...input },
      context,
    );
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Post('projects/:id/document-links')
  @RequiresScope('project-reconciliation:write')
  @ApiOperation({
    summary: 'Link an owned canonical document without changing accounting facts',
    description:
      'CUSTOMER_INVOICE requires COMPANY collection, nonnull caseId and an existing endCustomerClientId. Other roles may use caseId:null for a consolidated project link.',
  })
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiBody({ schema: wireSchema(schemas.linkDocument) })
  @ApiResponse({
    status: 201,
    description: 'MutationResult<DocumentLinkRecord>',
    schema: mutationResponse(schemas.documentLink),
  })
  @ApiResponse({
    status: 200,
    description: 'Idempotent retry',
    schema: mutationResponse(schemas.documentLink),
  })
  async linkDocument(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.linkDocument, body, request);
    const result = await this.service.linkDocument(companyId, id, input, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Post('projects/:id/document-links/:linkId/unlink')
  @RequiresScope('project-reconciliation:write')
  @ApiOperation({ summary: 'Remove only the reconciliation relationship' })
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiBody({ schema: wireSchema(schemas.reason) })
  @ApiResponse({
    status: 201,
    description: 'Removed relationship snapshot',
    schema: mutationResponse(schemas.documentLink),
  })
  @ApiResponse({
    status: 200,
    description: 'Idempotent retry',
    schema: mutationResponse(schemas.documentLink),
  })
  async unlinkDocument(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('linkId') linkId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.reason, body, request);
    const result = await this.service.unlinkDocument(companyId, id, { linkId, ...input }, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Post('projects/:id/evidence-coverage')
  @RequiresScope('project-reconciliation:write')
  @ApiOperation({
    summary: 'Attest the selected external invoices and complete active receipt/allocation set',
    description:
      'Requires fresh attested:true. Known selected invoice and active receipt dates must not exceed sourceAsOf civil date. Coverage does not create or promote receipt evidence.',
  })
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiBody({ schema: wireSchema(schemas.evidenceCoverage) })
  @ApiResponse({
    status: 201,
    description: 'Explicit immutable evidence coverage attestation',
    schema: mutationResponse(schemas.coverageResult),
  })
  @ApiResponse({
    status: 200,
    description: 'Idempotent retry',
    schema: mutationResponse(schemas.coverageResult),
  })
  async attestEvidenceCoverage(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.evidenceCoverage, body, request);
    const result = await this.service.attestEvidenceCoverage(companyId, id, input, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Post('projects/:id/cases/:caseId/review')
  @RequiresScope('project-reconciliation:write')
  @ApiOperation({
    summary: 'Review current canonical balances or explicitly accept exact historical exceptions',
    description:
      'Known positive own balances and required-link/source discrepancies cannot be overridden. SOURCE_CHANGED is a stale decision marker resolved by a fresh review, not an accepted exception.',
  })
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiBody({ schema: wireSchema(schemas.reviewCase) })
  @ApiResponse({
    status: 201,
    description: 'Auditable review decision with exact accepted exceptions/reasons',
    schema: mutationResponse(schemas.reviewResult),
  })
  @ApiResponse({
    status: 200,
    description: 'Idempotent retry',
    schema: mutationResponse(schemas.reviewResult),
  })
  async reviewCase(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Param('caseId') caseId: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { input, context } = mutation(schemas.reviewCase, body, request);
    const result = await this.service.reviewCase(companyId, id, { caseId, ...input }, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
  @Post('projects/:id/import/preview')
  @RequiresScope('project-reconciliation:write')
  @HttpCode(200)
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Preview bounded historical source facts and explicit own-document matches without writing',
    description:
      'Administrative import requires module write and all financial read scopes. Source Paid is never cash; blocking revisions require manual review.',
  })
  @ApiBody({ schema: responseSchema(schemas.importPreviewInput) })
  @ApiResponse({
    status: 200,
    description: 'ImportPreview; projectVersion is the aggregate token for confirm expectedVersion',
    schema: responseSchema(schemas.importPreview),
  })
  previewImport(@ActiveCompany() companyId: string, @Param('id') id: string, @Body() body: unknown) {
    return this.service.previewImport(companyId, id, body);
  }
  @Post('projects/:id/import/confirm')
  @RequiresScope('project-reconciliation:write')
  @Roles(CompanyRole.OWNER, CompanyRole.ADMIN)
  @ApiOperation({
    summary: 'Confirm the exact reviewed historical preview in one idempotent transaction',
    description:
      'Same payload and selectedMatches plus previewHash/requestKey/expectedVersion. No financial document, credit, payment, receipt or outgoing action is created.',
  })
  @ApiBody({ schema: wireSchema(schemas.importConfirm) })
  @ApiResponse({
    status: 201,
    description: 'ImportResult; new operation',
    schema: responseSchema(schemas.importResult),
  })
  @ApiResponse({
    status: 200,
    description: 'Exact idempotent retry; changed=false',
    schema: responseSchema(schemas.importResult),
  })
  async confirmImport(
    @ActiveCompany() companyId: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: RequestWithUser,
    @Res({ passthrough: true }) response: Response,
  ) {
    assertImportSize(body);
    const { input, context } = mutation(schemas.importConfirm, body, request);
    const result = await this.service.confirmImport(companyId, id, input, context);
    response.status(result.changed ? 201 : 200);
    return result;
  }
}
