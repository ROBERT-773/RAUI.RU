import {
  listingSubscriptionSchema,
  listingSubscriptionDisableSchema,
} from '../modules/product/subscription-contract';
import { aiRequest, flagRequest } from '../modules/ai/contracts';
import { trustDecision, duplicateDecision } from '../modules/trust/trust';
import { analyticsEvent } from '../modules/analytics/analytics';
import {
  emailSignInRequestSchema,
  emailSignInConfirmSchema,
  emailSignInRequestResultSchema,
} from '../modules/auth/email-sign-in';
import {
  phoneSignInConfirmSchema,
  phoneSignInRequestSchema,
} from '../modules/auth/phone-sign-in';
import {
  feedInput,
  feedLinkInput,
  feedProvider,
  feedConfig,
  importInput,
} from '../modules/professional/contracts';
import {
  orderInput,
  placementInput,
  campaignInput,
  promotionInput,
  advertisingEventInput,
} from '../modules/commerce/commerce';
import { featureInput } from '../modules/commerce/features';
import { searchSchema } from '../modules/search/contracts';
import { z } from 'zod';
import type {
  OpenAPIObject,
  SchemaObject,
  ParameterObject,
  ReferenceObject,
} from '@nestjs/swagger';
import {
  registerSchema,
  changePasswordSchema,
  registerWithPhoneSchema,
  phoneSignInEnrollmentSchema,
  loginSchema,
  passwordSchema,
} from '../modules/auth/auth';
import { uploadSchema } from '../modules/media/media';
import { createSchema } from '../modules/properties/properties';
import { createListingSchema, fields } from '../modules/listings/listings';
import {
  savedListingForm,
  saveListingForm,
} from '../modules/listings/form-drafts';
import { addressSchema } from '../modules/geo/geo';
import { staffPermissions, uuid } from './security';
import {
  contactModeSchema,
  contactSettingsPatchSchema,
  contactPhoneRequestSchema,
  contactPhoneVerifySchema,
  contactSettingsSchema,
  contactPhoneRequestResultSchema,
} from '../modules/auth/contact-settings';
import { listingContactSelectionSchema } from '../modules/listings/contact-settings';
import { feedbackInput } from '../modules/product/feedback';
import { professionalImageInput } from '../modules/professional/profile-image';
import {
  adminDirectorySearchSchema,
  adminListingDirectorySearchSchema,
  adminListingSearchResultSchema,
  adminUserSearchResultSchema,
} from '../modules/admin/directory-search';
import {
  staffTotpCodeInput,
  staffTotpEnrollmentInput,
} from '../modules/auth/staff-totp-controller';
const object = (shape: z.ZodRawShape) => z.object(shape).strict();
const version = z.number().int().positive();
const linkSummary = object({
  id: uuid,
  provider: feedProvider,
  host: z.string(),
  active: z.boolean(),
  trusted: z.boolean(),
  lastApplyRunId: uuid.nullable(),
});
const linkRun = object({
  id: uuid,
  status: z.enum(['running', 'succeeded', 'quarantined', 'failed']),
  stats: z.object({
    stage: z.string().optional(),
    total: z.number().optional(),
    valid: z.number().optional(),
    quarantined: z.number().optional(),
    created: z.number().optional(),
    updated: z.number().optional(),
    unchanged: z.number().optional(),
  }),
  error: z
    .string()
    .nullable()
    .describe(
      'Safe failure code. feed_provider_mismatch_<provider> identifies the detected format (generic for unmapped XML); feed_host_not_approved requires administrator approval. snapshot_unavailable means a partial run from an older worker must be replaced by a new check.',
    ),
});
const linkItem = object({
  external_reference: z.string(),
  duplicate_reference: z.string().nullable(),
  property_id: uuid.nullable(),
  listing_id: uuid.nullable(),
  status: z.string(),
  publication_result: z.enum(['created', 'updated', 'unchanged']).nullable(),
  errors: z.array(
    z.object({
      code: z.string(),
      message: z.string(),
      field: z.string().optional(),
    }),
  ),
});
const feedReads: Record<string, z.ZodType> = {};
const adminFeedRow = object({
  id: uuid,
  name: z.string(),
  organization_id: uuid.nullable(),
  ownerName: z.string(),
  active: z.boolean(),
  version,
  next_run_at: z.string().nullable(),
  provider: feedProvider.nullable(),
  host: z.string().nullable(),
  trustEligible: z.boolean(),
  trusted: z.boolean(),
});
const adminFeeds = '/v1/admin/integrations/feeds';
feedReads['get ' + adminFeeds] = z.array(adminFeedRow);
feedReads['patch ' + adminFeeds + '/{id}/trust'] = adminFeedRow;
for (const prefix of [
  '/v1/organizations/{organizationId}/feeds',
  '/v1/account/feeds',
]) {
  feedReads['post ' + prefix + '/link'] = object({
    feed: linkSummary,
    preview: object({ runId: uuid, status: z.literal('queued') }),
  });
  feedReads['get ' + prefix + '/links'] = z.array(
    linkSummary.extend({ lastRunId: uuid.nullable() }),
  );
  feedReads['get ' + prefix + '/{feedId}/runs/{runId}'] = linkRun;
  feedReads['get ' + prefix + '/{feedId}/runs/{runId}/items'] =
    z.array(linkItem);
}
const name = z.string().min(1).max(200);
const publicContact = object({
  messagesAllowed: z.boolean(),
  phones: z.array(z.string()).max(2),
});
const listingContactSettings = object({
  mode: contactModeSchema,
  canEdit: z.boolean(),
  phones: z.array(object({ id: uuid, phone: z.string() })).max(3),
  selectedPhoneIds: z.array(uuid).max(2),
});
const contactResponses: Record<string, z.ZodType> = {
  'get /v1/account/contact-settings': contactSettingsSchema,
  'patch /v1/account/contact-settings': contactSettingsSchema,
  'post /v1/account/contact-phones/request': contactPhoneRequestResultSchema,
  'post /v1/account/contact-phones/verify': contactSettingsSchema,
  'delete /v1/account/contact-phones/{id}': contactSettingsSchema,
  'get /v1/listings/{id}/contact-settings': listingContactSettings,
  'put /v1/listings/{id}/contact-settings': listingContactSettings,
  'get /v1/listings/{id}/public/contact': publicContact,
};
const bodyContracts: Record<string, z.ZodType> = {
  'post /v1/admin/search/users': adminDirectorySearchSchema,
  'post /v1/admin/search/listings': adminListingDirectorySearchSchema,
  'put /v1/search/professional-profile/image': professionalImageInput,
  'put /v1/search/professional-profile/agency/{id}/image':
    professionalImageInput,
  'post /v1/account/feedback': feedbackInput,
  'patch /v1/account/contact-settings': contactSettingsPatchSchema,
  'post /v1/account/contact-phones/request': contactPhoneRequestSchema,
  'post /v1/account/contact-phones/verify': contactPhoneVerifySchema,
  'put /v1/listings/{id}/contact-settings': listingContactSelectionSchema,
  'post /v1/auth/staff-totp/enroll': staffTotpEnrollmentInput,
  'post /v1/auth/staff-totp/activate': staffTotpCodeInput,
  'post /v1/auth/staff-totp/confirm': staffTotpCodeInput,
  'post /v1/ai/assist': aiRequest,
  'patch /v1/admin/ai/features/{code}': flagRequest,
  'post /v1/trust/listings/{id}/scan': object({}),
  'post /v1/admin/trust/listings/{id}/decision': trustDecision,
  'post /v1/admin/trust/candidates/{id}/decision': duplicateDecision,
  'post /v1/analytics/events': analyticsEvent,
  'post /v1/organizations/{organizationId}/feeds': feedInput,
  'post /v1/organizations/{organizationId}/feeds/link': feedLinkInput,
  'post /v1/account/feeds/link': feedLinkInput,
  'put /v1/account/listing-drafts/{id}': saveListingForm,
  'post /v1/organizations/{organizationId}/feeds/{feedId}/dry-run': importInput,
  'post /v1/organizations/{organizationId}/feeds/{feedId}/apply': importInput,
  'patch /v1/organizations/{organizationId}/feeds/{feedId}': feedConfig,
  'patch /v1/admin/integrations/feeds/{id}': feedConfig,
  'patch /v1/admin/integrations/feeds/{id}/trust': object({
    version,
    trusted: z.boolean(),
  }),
  'post /v1/partner/feeds/{id}/apply': importInput,
  'post /v1/organizations/{organizationId}/professional/portfolios': object({
    name: z.string().trim().min(2).max(120),
  }),
  'post /v1/organizations/{organizationId}/professional/portfolios/{portfolioId}/listings':
    object({ listingIds: z.array(uuid).min(1).max(200) }),
  'post /v1/organizations/{organizationId}/professional/listings/bulk-pause':
    object({ listingIds: z.array(uuid).min(1).max(200) }),
  'post /v1/partner/listings/bulk-pause': object({
    listingIds: z.array(uuid).min(1).max(200),
  }),
  'post /v1/organizations/{organizationId}/professional/partner-clients':
    object({
      name: z.string().trim().min(2).max(120),
      scopes: z
        .array(z.enum(['listings:read', 'listings:write', 'feeds:write']))
        .min(1)
        .max(10),
      expiresAt: z.iso.datetime().optional(),
      requestsPerMinute: z.number().int().min(1).max(1000).default(60),
    }),
  'patch /v1/notifications/preferences': object({
    email: z.boolean(),
    push: z.boolean(),
    transactional: z.boolean(),
  }),
  'post /v1/commerce/orders': orderInput,
  'post /v1/commerce/ads/placements': placementInput,
  'post /v1/commerce/ads/campaigns': campaignInput,
  'post /v1/commerce/ads/campaigns/{id}/events': advertisingEventInput,
  'post /v1/commerce/promotions': promotionInput,
  'patch /v1/commerce/features/{code}': featureInput,
  'patch /v1/commerce/promotions/{code}/{version}': object({
    enabled: z.boolean(),
  }),
  'post /v1/commerce/promotions/activate': object({
    listingId: uuid,
    code: z.string().min(2).max(64),
    version: z.number().int().positive(),
    paymentOrderId: uuid.optional(),
    startsAt: z.iso.datetime().optional(),
  }),

  'post /v1/geo/layers': object({
    bounds: searchSchema.shape.bounds.unwrap(),
    locality: z.string().max(150).optional(),
    kind: z.enum(['district', 'okrug']).default('district'),
  }),
  'post /v1/search': searchSchema,
  'post /v1/search/map': searchSchema,
  'post /v1/search/selection': object({
    ids: z.array(uuid).min(1).max(2000),
    definition: searchSchema,
  }),
  'post /v1/account/collections/{kind}': object({ listingId: uuid }),
  'post /v1/account/saved-searches': object({
    name: z.string().min(1).max(100),
    definition: searchSchema.omit({ cursor: true }),
  }),
  'patch /v1/account/saved-searches/{id}': object({
    name: z.string().min(1).max(100),
    definition: searchSchema.omit({ cursor: true }),
  }),
  'post /v1/account/inquiries/{id}': object({
    body: z.string().min(1).max(4000),
  }),
  'post /v1/account/threads/{id}/messages': object({
    body: z.string().min(1).max(4000),
  }),
  'post /v1/account/listing-subscriptions/{id}': listingSubscriptionSchema,
  'post /v1/account/listing-subscriptions/{id}/disable':
    listingSubscriptionDisableSchema,
  'patch /v1/account/preferences': object({
    in_app: z.boolean(),
    email: z.boolean(),
    sms: z.boolean(),
    push: z.boolean(),
  }),

  'patch /v1/admin/users/{id}/permissions': object({
    permission: z.enum(staffPermissions),
    granted: z.boolean(),
    reason: z.string().trim().min(3).max(2000),
  }),
  'post /v1/auth/register': registerSchema,
  'post /v1/auth/login': loginSchema,
  'post /v1/auth/phone-sign-in': phoneSignInRequestSchema,
  'post /v1/auth/email-sign-in': emailSignInRequestSchema,
  'post /v1/auth/email-sign-in/confirm': emailSignInConfirmSchema,
  'post /v1/auth/phone-sign-in/confirm': phoneSignInConfirmSchema,
  'post /v1/auth/phone-sign-in/register': registerWithPhoneSchema,
  'post /v1/auth/phone-sign-in/enroll': phoneSignInEnrollmentSchema,
  'post /v1/auth/verification/phone': object({
    phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  }),
  'post /v1/auth/verification/phone/otp': object({
    phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
  }),
  'post /v1/auth/verification/phone/otp/confirm': object({
    challengeId: uuid,
    code: z.string().regex(/^[0-9]{6}$/),
  }),
  'post /v1/auth/verification/phone/confirm': object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  'post /v1/auth/verification/email/confirm': object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  }),
  'post /v1/auth/password-reset': object({ email: z.email().max(254) }),
  'post /v1/auth/password': changePasswordSchema,
  'post /v1/auth/password-reset/confirm': object({
    token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    password: passwordSchema,
  }),
  'post /v1/organizations': object({
    name: z.string().min(2).max(200),
    kind: z.enum(['agency', 'developer']),
  }),
  'patch /v1/organizations/{id}/members': object({
    userId: uuid,
    role: z.enum(['admin', 'member']),
    active: z.boolean(),
  }),
  'post /v1/properties': createSchema,
  'patch /v1/properties/{id}': object({
    version,
    attributes: z
      .record(
        z.string().max(50),
        z.union([z.string().max(2000), z.number(), z.boolean()]),
      )
      .optional(),
    address: addressSchema
      .optional()
      .describe(
        'Only an administrator may correct the address after a listing has been created.',
      ),
  }),
  'post /v1/listings': createListingSchema,
  'patch /v1/listings/{id}': object({
    version,
    title: fields.title.optional(),
    price: fields.price.optional(),
    description: fields.description.optional(),
    terms: fields.terms.optional(),
  }),
  'post /v1/listings/{id}/transitions': object({
    version,
    status: z.enum([
      'draft',
      'processing',
      'moderation',
      'paused',
      'archived',
      'sold',
      'rented',
    ]),
  }),
  'post /v1/media': uploadSchema,
  'post /v1/structures/complexes': object({
    organizationId: uuid,
    name,
    address: addressSchema,
  }),
  'post /v1/structures/buildings': object({
    organizationId: uuid,
    name,
    address: addressSchema,
    complexId: uuid.optional(),
    completionDate: z.iso.date().optional(),
  }),
  'post /v1/structures/sections': object({
    buildingId: uuid,
    name: z.string().min(1).max(100),
  }),
  'post /v1/structures/floors': object({
    sectionId: uuid,
    number: z.number().int().min(-10).max(200),
  }),
  'post /v1/admin/moderation/{id}/decision': object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().min(3).max(2000),
  }),
  'post /v1/admin/registration-approvals/{id}/decision': object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().min(3).max(2000),
  }),
  'patch /v1/admin/users/{id}': object({
    active: z.boolean().optional(),
    role: z
      .enum(['buyer', 'owner', 'agent', 'agency', 'developer', 'admin'])
      .optional(),
  }),
  'patch /v1/admin/organizations/{id}': object({ active: z.boolean() }),
  'put /v1/categories/{code}/attributes': object({
    code: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    name: z.string().min(1).max(100),
    kind: z.enum(['string', 'number', 'boolean', 'enum']),
    required: z.boolean(),
    options: z.array(z.string().max(100)).max(100).default([]),
  }),
};
const anonymousOperations = new Set(
  `get /health
get /health/ready
get /v1/categories
get /v1/categories/{code}/attributes
get /v1/listings/{id}/public
get /v1/listings/{id}/public/contact
get /v1/media/{id}/{variant}
get /v1/search/sitemap
get /v1/search/sitemap/partitions
get /v1/search/locations
get /v1/search/recent
get /v1/search/region-counts
get /v1/search/professionals
get /v1/search/professionals/{id}
get /v1/search/professionals/{id}/image/{imageId}
post /v1/search
post /v1/search/selection
post /v1/search/map
post /v1/geo/layers
post /v1/commerce/webhook
post /v1/auth/register
post /v1/auth/login
get /v1/auth/phone-sign-in/capabilities
get /v1/auth/email-sign-in/capabilities
get /v1/auth/password-reset/capabilities
post /v1/auth/email-sign-in
post /v1/auth/email-sign-in/confirm
post /v1/auth/phone-sign-in
post /v1/auth/phone-sign-in/confirm
post /v1/auth/phone-sign-in/register
post /v1/auth/verification/email/confirm
post /v1/auth/password-reset
post /v1/auth/password-reset/confirm`.split('\n'),
);
const partnerOperations = new Set(
  `get /v1/partner/listings
post /v1/partner/feeds/{id}/apply
post /v1/partner/listings/bulk-pause`.split('\n'),
);
const idempotentOperations = new Set(
  `post /v1/auth/verification/phone/otp
post /v1/auth/phone-sign-in
post /v1/auth/email-sign-in
post /v1/organizations
post /v1/properties
post /v1/listings
post /v1/listings/{id}/transitions
post /v1/media
post /v1/structures/complexes
post /v1/structures/buildings
post /v1/structures/sections
post /v1/structures/floors
post /v1/admin/media-jobs/{id}/retry
post /v1/admin/moderation/{id}/decision
post /v1/admin/registration-approvals/{id}/decision
post /v1/trust/listings/{id}/scan
post /v1/admin/trust/listings/{id}/decision
post /v1/admin/trust/candidates/{id}/decision
post /v1/organizations/{organizationId}/feeds
post /v1/organizations/{organizationId}/feeds/link
post /v1/account/feeds/link
post /v1/organizations/{organizationId}/feeds/{feedId}/dry-run
post /v1/organizations/{organizationId}/feeds/{feedId}/apply
post /v1/organizations/{organizationId}/professional/portfolios
post /v1/organizations/{organizationId}/professional/portfolios/{portfolioId}/listings
post /v1/organizations/{organizationId}/professional/listings/bulk-pause
post /v1/organizations/{organizationId}/professional/partner-clients
post /v1/partner/feeds/{id}/apply
post /v1/partner/listings/bulk-pause
post /v1/commerce/orders
post /v1/commerce/ads/campaigns/{id}/events
post /v1/commerce/reconciliation/{id}/retry
post /v1/commerce/promotions/activate
post /v1/commerce/ads/placements
post /v1/commerce/ads/campaigns
post /v1/commerce/promotions
patch /v1/commerce/promotions/{code}/{version}`.split('\n'),
);
const httpMethods = new Set([
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
]);
export function enrichOpenApi(document: OpenAPIObject) {
  document.components ??= {};
  document.components.securitySchemes ??= {};
  document.components.securitySchemes.partner = {
    type: 'apiKey',
    in: 'header',
    name: 'X-Partner-Token',
    description: 'Organization-scoped server-side partner token',
  };
  for (const [path, methods] of Object.entries(document.paths))
    for (const [method, operation] of Object.entries(methods)) {
      if (
        !httpMethods.has(method) ||
        !operation ||
        typeof operation !== 'object'
      )
        continue;
      const operationId = `${method} ${path}`;
      operation.security = anonymousOperations.has(operationId)
        ? []
        : partnerOperations.has(operationId)
          ? [{ partner: [] }]
          : [{ bearer: [] }, { cookie: [] }];
      const schema = bodyContracts[`${method} ${path}`];
      if (schema)
        operation.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: z.toJSONSchema(schema, {
                io: 'input',
                unrepresentable: 'any',
              }) as SchemaObject,
            },
          },
        };
      if (idempotentOperations.has(operationId))
        operation.parameters = [
          ...(operation.parameters ?? []).filter(
            (parameter: ParameterObject | ReferenceObject) =>
              !(
                'in' in parameter &&
                parameter.in === 'header' &&
                parameter.name.toLowerCase() === 'idempotency-key'
              ),
          ),
          {
            in: 'header',
            name: 'Idempotency-Key',
            required: true,
            schema: {
              type: 'string',
              minLength: 8,
              maxLength: path.startsWith('/v1/commerce/') ? 128 : 100,
              pattern: path.startsWith('/v1/commerce/')
                ? '^[A-Za-z0-9._:-]{8,128}$'
                : '^[A-Za-z0-9_-]{8,100}$',
            },
          },
        ];
      if (operationId === 'post /v1/commerce/webhook')
        operation.parameters = [
          ...(operation.parameters ?? []).filter(
            (parameter: ParameterObject | ReferenceObject) =>
              !(
                'in' in parameter &&
                parameter.in === 'header' &&
                parameter.name.toLowerCase() === 'x-payment-signature'
              ),
          ),
          {
            in: 'header',
            name: 'X-Payment-Signature',
            required: true,
            schema: { type: 'string' },
          },
        ];
      operation.responses = {
        ...operation.responses,
        '400': { description: 'Validation error' },
        '401': { description: 'Authentication required' },
        '403': { description: 'Authorization/CSRF failure' },
        '409': { description: 'Conflict/stale version' },
        '429': { description: 'Rate limit' },
        '503': {
          description: 'Dependency unavailable or commercial feature disabled',
        },
      };
      if (operationId === 'get /v1/auth/password-reset/capabilities') {
        operation.responses['200'] = {
          description:
            'Configured recovery channels, independent of the account',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', example: 'no-store' },
            },
          },
          content: {
            'application/json': {
              schema: z.toJSONSchema(
                z.strictObject({
                  smsAvailable: z.boolean(),
                  emailAvailable: z.boolean(),
                  resetLinkAvailable: z.boolean(),
                }),
              ) as SchemaObject,
            },
          },
        };
      }
      if (
        operationId === 'post /v1/auth/email-sign-in' ||
        operationId === 'get /v1/auth/email-sign-in/capabilities'
      ) {
        const request = operationId.startsWith('post');
        operation.responses[request ? '201' : '200'] = {
          description: request
            ? 'Uniform receipt for an address, including idempotent retries'
            : 'Availability of email-code login',
          content: {
            'application/json': {
              schema: z.toJSONSchema(
                request
                  ? emailSignInRequestResultSchema
                  : z.strictObject({ available: z.boolean() }),
              ) as SchemaObject,
            },
          },
        };
        if (request) {
          operation.responses['409'] = {
            description: 'Idempotency key already used for another address',
          };
          operation.responses['429'] = {
            description: 'Address or IP request budget exhausted',
            headers: {
              'Retry-After': {
                description: 'Seconds until next address attempt, when present',
                schema: { type: 'integer' },
              },
            },
          };
          operation.responses['503'] = {
            description:
              'Email sign-in disabled, unconfigured, or unavailable before recipient delivery. A retry with the same key preserves a known delivery failure.',
          };
        }
      }
      if (
        operationId === 'post /v1/admin/search/users' ||
        operationId === 'post /v1/admin/search/listings'
      ) {
        const users = path.endsWith('/users');
        operation.description = users
          ? 'Administrator-only search by public ID, email, name or full phone number. Submit personal information in the JSON body. Only an exact phone match is returned in matchedPhone.'
          : 'Administrator-only search by listing ID, title or address, or exact seller public ID with by=seller, across listing statuses. A public link is available only for an eligible published listing.';
        delete operation.responses['201'];
        operation.responses['200'] = {
          description:
            'Results in UUID order and the cursor for the next page, if present.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', example: 'no-store' },
            },
          },
          content: {
            'application/json': {
              schema: z.toJSONSchema(
                users
                  ? adminUserSearchResultSchema
                  : adminListingSearchResultSchema,
              ) as SchemaObject,
            },
          },
        };
      }
      if (contactResponses[operationId]) {
        operation.responses[method === 'post' ? '201' : '200'] = {
          description: path.endsWith('/public/contact')
            ? 'Current message permission and explicitly selected verified phones in display order. A guest can read contacts only for a public listing.'
            : 'Current contact settings for the authorized account or listing editor.',
          headers: {
            'Cache-Control': {
              schema: { type: 'string', example: 'private, no-store' },
            },
          },
          content: {
            'application/json': {
              schema: z.toJSONSchema(
                contactResponses[operationId],
              ) as SchemaObject,
            },
          },
        };
      }
      if (operationId === 'post /v1/account/feedback') {
        operation.description =
          'An authenticated account submits a private suggestion. Leading and trailing whitespace is removed. Retries with the same requestId and trimmed message return the original id.';
        operation.responses['201'] = {
          description: 'Recorded suggestion or identical retry',
          content: {
            'application/json': {
              schema: z.toJSONSchema(object({ id: uuid })) as SchemaObject,
            },
          },
        };
        operation.responses['409'] = {
          description:
            'This account already used requestId with a different message (feedback_request_conflict).',
        };
      }
      if (operationId === 'get /v1/admin/feedback') {
        operation.description =
          'Administrator only. Newest first, with UUID as the tie-breaker. Delegated moderation permissions do not grant access.';
        operation.parameters = [
          {
            in: 'query',
            name: 'cursor',
            required: false,
            description:
              'Pass the opaque nextCursor returned by the previous page. It retains its position after deletion of that suggestion.',
            schema: { type: 'string', minLength: 64, maxLength: 64 },
          },
          {
            in: 'query',
            name: 'limit',
            required: false,
            schema: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        ];
        operation.responses['200'] = {
          description:
            'Private suggestions with public account IDs. nextCursor is null on the last page.',
          content: {
            'application/json': {
              schema: z.toJSONSchema(
                object({
                  items: z.array(
                    object({
                      id: uuid,
                      message: z.string(),
                      createdAt: z.iso.datetime(),
                      authorId: z.string().regex(/^[1-9]\d*$/),
                    }),
                  ),
                  nextCursor: z.string().length(64).nullable(),
                }),
              ) as SchemaObject,
            },
          },
        };
      }
      if (
        operationId === 'patch /v1/account/contact-settings' ||
        operationId === 'delete /v1/account/contact-phones/{id}'
      ) {
        operation.responses['409'] = {
          description:
            'The change would leave a published or submitted listing without its last phone in calls-only mode. The owner can select a replacement before retrying.',
        };
      }
      if (operationId === 'put /v1/listings/{id}/contact-settings') {
        operation.responses['409'] = {
          description:
            'Another edit changed the selection since expectedPhoneIds. Reload the current selection and confirm the intended numbers.',
        };
      }
      if (operationId === 'post /v1/account/inquiries/{id}') {
        operation.responses['403'] = {
          description:
            'Forbidden, invalid CSRF, or LISTING_MESSAGES_DISABLED when the seller accepts only calls on the listing.',
        };
      }
      if (operationId === 'get /v1/listings/summary') {
        const count = { type: 'integer', minimum: 0 } as const;
        operation.responses['200'] = {
          description:
            'All accessible listings across all statuses plus the verified seller’s unfinished personal forms. Rent includes long-term and short-term offers.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['total', 'sale', 'rent'],
                properties: { total: count, sale: count, rent: count },
                additionalProperties: false,
              },
            },
          },
        };
      }
      if (
        operationId === 'get /v1/account/listing-drafts' ||
        operationId === 'put /v1/account/listing-drafts/{id}'
      ) {
        operation.responses['200'] = {
          description:
            method === 'get'
              ? 'Unfinished listing forms saved by the signed-in seller'
              : 'Saved form with its current version',
          content: {
            'application/json': {
              schema: z.toJSONSchema(
                method === 'get' ? z.array(savedListingForm) : savedListingForm,
              ) as SchemaObject,
            },
          },
        };
        if (method === 'put')
          operation.responses['404'] = {
            description:
              'No form draft owned by this seller with the requested ID',
          };
      }
      if (feedReads[operationId]) {
        if (path === adminFeeds)
          operation.parameters = [
            ...(operation.parameters ?? []),
            {
              in: 'query',
              name: 'after',
              description:
                'Exclusive source ID; each page contains at most 100 rows.',
              schema: { type: 'string', format: 'uuid' },
            },
          ];
        if (path === adminFeeds + '/{id}/trust')
          operation.responses['409'] = {
            description:
              'Stale source version or source is ineligible for approval. Reload the source list before another decision.',
          };
        if (method === 'post' && path.endsWith('/link'))
          operation.responses['400'] = {
            description:
              'Invalid feed link. A valid HTTPS address on a host that needs administrator approval returns code feed_host_not_approved.',
          };
        operation.responses[method === 'post' ? '201' : '200'] = {
          description:
            method === 'post'
              ? 'Saved link and queued preview'
              : path.startsWith(adminFeeds)
                ? 'Administrative feed trust status'
                : 'XML source or import report',
          content: {
            'application/json': {
              schema: z.toJSONSchema(feedReads[operationId]!) as SchemaObject,
            },
          },
        };
        if (path.endsWith('/items'))
          operation.parameters = [
            ...(operation.parameters ?? []),
            { in: 'query', name: 'errorsOnly', schema: { type: 'boolean' } },
            {
              in: 'query',
              name: 'limit',
              schema: {
                type: 'integer',
                minimum: 1,
                maximum: 200,
                default: 50,
              },
            },
            {
              in: 'query',
              name: 'after',
              schema: { type: 'string', maxLength: 200 },
            },
          ];
      }
      if (operationId === 'get /v1/listings/{id}/history') {
        const historyWindow =
          'The 200 most recent listing events at most, returned in ascending event ID order.';
        operation.description = historyWindow;
        operation.responses['200'] = { description: historyWindow };
      }
      if (operationId === 'get /v1/listings/{id}/public') {
        operation.responses['200'] = {
          description:
            'Published listing with any declared public rental terms',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  contact: z.toJSONSchema(publicContact) as SchemaObject,
                  sellerType: {
                    type: 'string',
                    enum: ['owner', 'agent', 'agency', 'developer', 'other'],
                    description:
                      'Public advertiser type, including when no public profile is visible.',
                  },
                  professionals: {
                    type: 'array',
                    maxItems: 2,
                    items: {
                      type: 'object',
                      required: ['id', 'name', 'kind', 'imageId'],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        kind: { type: 'string', enum: ['agent', 'agency'] },
                        imageId: {
                          type: 'string',
                          format: 'uuid',
                          nullable: true,
                        },
                      },
                    },
                  },
                  rentalTerms: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      deposit: {
                        type: 'number',
                        minimum: 0,
                        maximum: 999999999,
                      },
                      commission: { type: 'number', minimum: 0, maximum: 100 },
                      utilitiesIncluded: { type: 'boolean' },
                      availableFrom: { type: 'string', format: 'date' },
                      availableUntil: { type: 'string', format: 'date' },
                      guestCapacity: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 9999,
                      },
                      minimumNights: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 365,
                      },
                    },
                  },
                },
              },
            },
          },
        };
      }
      if (
        [
          'get /v1/auth/verification/phone/capabilities',
          'post /v1/auth/verification/phone/otp',
          'post /v1/auth/verification/phone/otp/confirm',
        ].includes(operationId)
      ) {
        operation.description =
          'Own-account phone verification for active pending or approved accounts; private, no-store. Contact verification never grants registration approval.';
        const json = (schema: SchemaObject, description: string) => ({
          description,
          content: { 'application/json': { schema } },
        });
        const strict = (
          properties: Record<string, SchemaObject>,
        ): SchemaObject => ({
          type: 'object',
          additionalProperties: false,
          required: Object.keys(properties),
          properties,
        });
        if (method === 'get') {
          operation.responses['200'] = json(
            strict({
              numericOtp: strict({
                available: { type: 'boolean' },
                reason: {
                  type: 'string',
                  enum: ['available', 'disabled', 'unconfigured'],
                },
              }),
              legacyToken: strict({
                available: { type: 'boolean', enum: [true] },
              }),
            }),
            'Configuration availability, never proof of provider health or SMS delivery',
          );
        } else if (path.endsWith('/confirm')) {
          operation.responses['201'] = json(
            strict({ verified: { type: 'boolean', enum: [true] } }),
            'Phone verified after committed contact update',
          );
          operation.responses['400'] = {
            description:
              'Invalid, wrong-user, consumed, expired or exhausted challenge: phone_otp_invalid. No attempt count is exposed.',
          };
          operation.responses['409'] = {
            description:
              'Claimed phone unavailable: phone_otp_contact_unavailable. No account details are exposed.',
          };
        } else {
          operation.responses['201'] = json(
            strict({
              challengeId: { type: 'string', format: 'uuid' },
              expiresAt: { type: 'string', format: 'date-time' },
              resendAfter: { type: 'string', format: 'date-time' },
              delivery: {
                type: 'string',
                enum: ['accepted', 'unavailable', 'unknown'],
              },
            }),
            'Durable challenge allocation; acceptance does not confirm delivery; replay causes no new dispatch',
          );
          operation.responses['409'] = {
            description: 'Idempotency key reused with a different phone',
          };
          operation.responses['429'] = {
            ...json(
              strict({
                code: { type: 'string', enum: ['phone_otp_rate_limited'] },
                message: { type: 'string' },
                retryAfterSeconds: { type: 'integer', minimum: 1 },
              }),
              'Cooldown or rolling send quota exceeded',
            ),
            headers: {
              'Retry-After': {
                schema: { type: 'integer', minimum: 1 },
                description: 'Seconds until retry',
              },
            },
          };
          operation.responses['503'] = {
            description:
              'Numeric OTP disabled or unconfigured: phone_otp_unavailable. No challenge, send event or dispatch is created.',
          };
        }
      }
      if (
        operationId === 'get /v1/account/notifications' ||
        operationId === 'post /v1/account/notifications/{id}/read'
      ) {
        const decimalId: SchemaObject = {
          type: 'string',
          pattern: '^[1-9][0-9]{0,18}$',
          description:
            'Exact positive PostgreSQL bigint decimal string, at most 9223372036854775807; never a JavaScript number',
        };
        operation.description =
          'Owned account inbox. Message behavior is preserved. Immediate in-app subscription rows require current consent/channel/preferences, subscription version and latest full-public listing state; unavailable events are neutral. Daily digest is not implemented. Authorization is point-in-time; already received content cannot be recalled.';
        if (method === 'get') {
          const common: Record<string, SchemaObject> = {
            id: decimalId,
            read_at: { type: 'string', format: 'date-time', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          };
          const shape = (
            properties: Record<string, SchemaObject>,
          ): SchemaObject => ({
            type: 'object',
            additionalProperties: false,
            required: Object.keys(properties),
            properties,
          });
          const priceEvent = shape({
            kind: { type: 'string', enum: ['price_drop'] },
            previousPriceMinor: {
              type: 'integer',
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
            priceMinor: {
              type: 'integer',
              minimum: 1,
              maximum: Number.MAX_SAFE_INTEGER,
            },
          });
          const availabilityEvent = shape({
            kind: { type: 'string', enum: ['availability'] },
            available: { type: 'boolean' },
          });
          operation.parameters = [
            {
              in: 'query',
              name: 'cursor',
              required: false,
              schema: decimalId,
              description:
                'Exclusive last scanned raw id. An empty filtered page may still have a cursor.',
            },
            {
              in: 'query',
              name: 'limit',
              required: false,
              schema: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
            },
          ];
          operation.responses['200'] = {
            description: 'Safe current inbox rows and advancing raw cursor',
            content: {
              'application/json': {
                schema: shape({
                  items: {
                    type: 'array',
                    items: {
                      oneOf: [
                        shape({
                          ...common,
                          kind: { type: 'string', enum: ['message'] },
                          thread_id: { type: 'string', format: 'uuid' },
                        }),
                        shape({
                          ...common,
                          kind: {
                            type: 'string',
                            enum: ['subscription.listing.price_drop'],
                          },
                          listing_id: { type: 'string', format: 'uuid' },
                          event: priceEvent,
                        }),
                        shape({
                          ...common,
                          kind: {
                            type: 'string',
                            enum: ['subscription.listing.availability'],
                          },
                          listing_id: { type: 'string', format: 'uuid' },
                          event: availabilityEvent,
                        }),
                      ],
                    },
                  },
                  cursor: { ...decimalId, nullable: true },
                }),
              },
            },
          };
        } else {
          operation.parameters = [
            ...(operation.parameters ?? []).filter(
              (parameter: ParameterObject | ReferenceObject) =>
                !(
                  'name' in parameter &&
                  parameter.name === 'id' &&
                  parameter.in === 'path'
                ),
            ),
            { name: 'id', in: 'path', required: true, schema: decimalId },
          ];
          operation.responses['404'] = {
            description:
              'Notification not owned or no longer eligible; read state unchanged',
          };
          operation.responses['201'] = {
            description:
              'Eligible notification marked read; repeated reads are idempotent',
          };
        }
      }
      if (path.startsWith('/v1/account/listing-subscriptions')) {
        operation.description =
          'Own-account listing subscriptions. Favorites do not imply consent. Saving preferences does not establish delivery; worker/channel configuration and current preferences govern notifications.';
        if (path.includes('{id}')) {
          operation.parameters = [
            ...(operation.parameters ?? []).filter(
              (parameter: ParameterObject | ReferenceObject) =>
                !(
                  'name' in parameter &&
                  parameter.name === 'id' &&
                  parameter.in === 'path'
                ),
            ),
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ];
          operation.responses['404'] = {
            description:
              'Listing unavailable for subscription, or subscription not owned by current account',
          };
        }
        if (path.endsWith('/disable')) {
          operation.responses['409'] = {
            description:
              'Stale subscription version; reload current preferences',
          };
          operation.responses['201'] = {
            description:
              'Subscription disabled for current account. After successful disable, no new transport attempts for the previous subscription start. Messages already accepted by the provider cannot be recalled.',
          };
        }
      }
      if (operationId === 'patch /v1/organizations/{id}/members')
        operation.description =
          'Organization owner/admin membership management. Deactivation preserves the stored role, removes organization access and permanently revokes active partner clients created by that member. Reactivation does not restore prior credentials; reactivation or any role change revokes legacy active clients. Create a new partner client explicitly after the membership change.';
      if (operationId === 'get /v1/account/publication-quota') {
        const required = ['applies', 'limit', 'publishedObjects', 'remaining'];
        operation.description =
          'Own-account informational capacity. Owners may have one published listing across all sources; drafts and nonpublic offers consume no active slot. Each transition into publication counts toward three publications per Moscow calendar month. Existing over-limit publications are preserved. This snapshot does not reserve publication capacity.';
        operation.responses['200'] = {
          description:
            'Current owner capacity, or null quota fields for other roles',
          content: {
            'application/json': {
              schema: {
                oneOf: [
                  {
                    type: 'object',
                    additionalProperties: false,
                    required,
                    properties: {
                      applies: { type: 'boolean', enum: [true] },
                      limit: { type: 'integer', enum: [1] },
                      publishedObjects: { type: 'integer', minimum: 0 },
                      remaining: { type: 'integer', minimum: 0, maximum: 1 },
                    },
                  },
                  {
                    type: 'object',
                    additionalProperties: false,
                    required,
                    properties: {
                      applies: { type: 'boolean', enum: [false] },
                      limit: { type: 'integer', nullable: true, enum: [null] },
                      publishedObjects: {
                        type: 'integer',
                        nullable: true,
                        enum: [null],
                      },
                      remaining: {
                        type: 'integer',
                        nullable: true,
                        enum: [null],
                      },
                    },
                  },
                ],
              },
            },
          },
        };
      }
      if (operationId === 'post /v1/admin/moderation/{id}/decision') {
        operation.responses['409'] = {
          description:
            'Stale case/version or owner publication quota exceeded. A quota denial leaves the current case pending; staff may retry after capacity is released.',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['statusCode', 'message'],
                properties: {
                  statusCode: { type: 'integer', enum: [409] },
                  message: { type: 'string' },
                  code: {
                    type: 'string',
                    enum: ['OWNER_PUBLICATION_QUOTA_EXCEEDED'],
                  },
                  error: { type: 'string' },
                },
              },
            },
          },
        };
      }
      if (
        [
          'post /v1/auth/register',
          'post /v1/auth/login',
          'post /v1/auth/email-sign-in/confirm',
          'post /v1/auth/password',
          'get /v1/auth/me',
        ].includes(operationId)
      ) {
        const userSchema: SchemaObject = {
          type: 'object',
          required: [
            'id',
            'public_id',
            'email',
            'display_name',
            'role',
            'active',
            'registration_approval_state',
          ],
          additionalProperties: false,
          properties: {
            id: { type: 'string', format: 'uuid' },
            public_id: {
              type: 'string',
              pattern: '^[1-9][0-9]*$',
              description:
                'Permanent numeric identifier, encoded as a string; not an authentication secret',
            },
            email: { type: 'string', format: 'email' },
            display_name: { type: 'string' },
            role: {
              type: 'string',
              enum: ['buyer', 'owner', 'agent', 'agency', 'developer', 'admin'],
            },
            active: { type: 'boolean' },
            registration_approval_state: {
              type: 'string',
              enum: ['pending', 'approved', 'rejected'],
            },
            registration_approval_reason: { type: 'string', nullable: true },
            ...(operationId === 'post /v1/auth/register'
              ? {
                  verificationDelivery: {
                    type: 'string' as const,
                    enum: ['accepted', 'unavailable'],
                  },
                }
              : {}),
            phone: { type: 'string', nullable: true },
            email_verified_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
            phone_verified_at: {
              type: 'string',
              format: 'date-time',
              nullable: true,
            },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
            ...(operationId === 'get /v1/auth/me'
              ? {
                  twoFactorEnabled: { type: 'boolean' as const, enum: [false] },
                  passwordChangeMode: {
                    type: 'string' as const,
                    enum: ['current-password', 'recent-code', 'recovery-link'],
                  },
                }
              : {}),
          },
        };
        operation.responses[operationId.startsWith('post') ? '201' : '200'] = {
          description: 'Account identity; public_id is informational only',
          content: {
            'application/json': {
              schema:
                operationId === 'post /v1/auth/login' ||
                operationId === 'post /v1/auth/password' ||
                operationId === 'post /v1/auth/email-sign-in/confirm'
                  ? {
                      type: 'object',
                      required: ['user', 'csrfToken'],
                      properties: {
                        user: userSchema,
                        csrfToken: { type: 'string' },
                        ...(operationId === 'post /v1/auth/login'
                          ? {
                              sessionToken: {
                                type: 'string',
                                description: 'Bearer transport only',
                              },
                            }
                          : {}),
                      },
                    }
                  : userSchema,
            },
          },
        };
      }
      if (operationId === 'get /v1/admin/moderation/{id}/materials') {
        operation.description =
          'Current pending-case materials for an administrator or staff with moderation.read; excludes private contacts, storage keys and authentication data.';
      }
      if (operationId.endsWith('/v1/admin/users/{id}/permissions')) {
        operation.description =
          'Administrator-only delegated moderation and registration permissions. Changes require an audit reason and do not change account roles.';
      }
      if (path.startsWith('/v1/admin/registration-approvals')) {
        operation.description =
          method === 'post'
            ? 'Administrator or registration.decide staff: audited idempotent decision on pending registration; approval requires both verified contacts and active applicant. Authorization is rechecked before replay. No self-review.'
            : 'Administrator or registration.read staff: private registration queue and contact evidence; excludes credentials, tokens and sessions.';
      }
      if (
        operationId ===
        'get /v1/admin/moderation/{id}/media/{mediaId}/{variant}'
      ) {
        operation.description =
          'Administrator or staff with moderation.read may inspect ready images belonging to the current pending moderation case. No public access or storage keys.';
        operation.parameters = [
          ...(operation.parameters ?? []).filter(
            (p: ParameterObject | ReferenceObject) =>
              !('name' in p && p.name === 'variant'),
          ),
          {
            name: 'variant',
            in: 'path',
            required: true,
            schema: {
              type: 'string',
              enum: ['thumb', 'small', 'large', 'avif'],
            },
          },
        ];
        operation.responses['200'] = {
          description:
            'Ready image for the current pending moderation case; private, no-store',
          content: {
            'image/webp': { schema: { type: 'string', format: 'binary' } },
            'image/avif': { schema: { type: 'string', format: 'binary' } },
          },
        };
        operation.responses['404'] = {
          description: 'Current pending case or matching ready image not found',
        };
      }
      if (path.startsWith('/v1/auth/staff-totp/')) {
        operation.security = [{ bearer: [] }, { cookie: [] }];
        operation.responses['403'] = {
          description: 'Staff identity, code or session rejected',
        };
        operation.responses['429'] = {
          description: 'Too many verification attempts',
        };
        operation.responses['503'] = {
          description: 'Staff second factor unavailable',
        };
        if (operationId === 'get /v1/auth/staff-totp/status') {
          operation.responses['200'] = {
            description:
              'Uncached staff verification status for the current session',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: [
                    'enrolled',
                    'assuredUntil',
                    'available',
                    'required',
                  ],
                  properties: {
                    enrolled: { type: 'boolean' },
                    assuredUntil: {
                      type: 'string',
                      format: 'date-time',
                      nullable: true,
                    },
                    available: { type: 'boolean' },
                    required: { type: 'boolean' },
                  },
                },
              },
            },
          };
        } else if (operationId === 'post /v1/auth/staff-totp/enroll') {
          operation.responses['201'] = {
            description:
              'Uncached TOTP enrollment secret for the current session',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['secret', 'expiresAt'],
                  properties: {
                    secret: { type: 'string', pattern: '^[A-Z2-7]{32}$' },
                    expiresAt: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          };
          operation.responses['409'] = {
            description: 'Enrollment unavailable',
          };
        } else {
          delete operation.responses['201'];
          operation.responses['204'] = {
            description: 'Current session verified',
          };
        }
      }
      if (operationId === 'get /v1/auth/csrf') {
        operation.security = [{ cookie: [] }];
        operation.responses['200'] = {
          description:
            'Uncached cookie-session CSRF token; not an authentication token',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['csrfToken'],
                additionalProperties: false,
                properties: {
                  csrfToken: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' },
                },
              },
            },
          },
        };
      }
      if (
        [
          'patch /v1/search/professional-profile',
          'patch /v1/search/professional-profile/agency/{id}',
        ].includes(operationId)
      ) {
        operation.requestBody = {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name', 'regionCodes', 'published'],
                properties: {
                  name: { type: 'string', minLength: 1, maxLength: 120 },
                  regionCodes: {
                    type: 'array',
                    maxItems: 20,
                    items: { type: 'string' },
                  },
                  published: { type: 'boolean' },
                },
              },
            },
          },
        };
      }
      if (
        [
          '/v1/search/professional-profile',
          '/v1/search/professional-profile/agency/{id}',
        ].includes(path) &&
        (method === 'get' || method === 'patch')
      ) {
        const profile = object({
          id: uuid,
          imageId: uuid.nullable(),
          name: z.string(),
          regionCodes: z.array(z.string()),
          published: z.boolean(),
        });
        operation.responses['200'] = {
          description:
            method === 'get'
              ? 'Current editable profile, if created.'
              : 'Saved profile.',
          content: {
            'application/json': {
              schema: z.toJSONSchema(
                method === 'get'
                  ? object({ profile: profile.nullable() })
                  : profile,
              ) as SchemaObject,
            },
          },
        };
      }
      if (
        path.startsWith('/v1/search/professional') &&
        path.includes('/image')
      ) {
        if (method === 'get') {
          operation.responses['200'] = {
            description: 'Current profile picture; private, no-store.',
            content: {
              'image/webp': { schema: { type: 'string', format: 'binary' } },
            },
          };
        } else {
          operation.responses['200'] = {
            description:
              method === 'put' ? 'Saved picture version.' : 'Picture removed.',
            content: {
              'application/json': {
                schema: z.toJSONSchema(
                  object({ imageId: method === 'put' ? uuid : z.null() }),
                ) as SchemaObject,
              },
            },
          };
          operation.responses['409'] = {
            description:
              'The picture has changed. Reload the profile before editing again.',
          };
        }
        if (method === 'put')
          operation.responses['400'] = {
            description: 'Invalid image or upload parameters.',
          };
        if (path.startsWith('/v1/search/professional-profile/'))
          operation.responses['403'] = {
            description: 'Profile editing permission is required.',
          };
        operation.responses['404'] = {
          description: 'Requested profile or image version is unavailable.',
        };
      }
      if (operationId === 'get /v1/search/professionals/{id}') {
        operation.parameters = [
          ...(operation.parameters ?? []),
          { name: 'regionCode', in: 'query', schema: { type: 'string' } },
          {
            name: 'page',
            in: 'query',
            schema: {
              type: 'integer',
              minimum: 1,
              maximum: 999999999,
              default: 1,
            },
          },
        ];
        operation.responses['200'] = {
          description: 'Published professional profile and its work regions',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: [
                  'id',
                  'name',
                  'kind',
                  'regionCodes',
                  'imageId',
                  'listings',
                  'listingCount',
                  'listingPageCount',
                  'listingCountsByRegion',
                ],
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  kind: { type: 'string', enum: ['agent', 'agency'] },
                  regionCodes: { type: 'array', items: { type: 'string' } },
                  imageId: { type: 'string', format: 'uuid', nullable: true },
                  listingCount: { type: 'integer', minimum: 0 },
                  listingPageCount: { type: 'integer', minimum: 0 },
                  listingCountsByRegion: {
                    type: 'object',
                    additionalProperties: { type: 'integer', minimum: 0 },
                  },
                  listings: {
                    type: 'array',
                    maxItems: 12,
                    items: { type: 'object' },
                  },
                },
              },
            },
          },
        };
        operation.responses['404'] = {
          description: 'Public profile not found',
        };
      }
      if (operationId === 'get /v1/search/professionals') {
        operation.parameters = [
          {
            name: 'regionCode',
            in: 'query',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'kind',
            in: 'query',
            schema: { type: 'string', enum: ['agent', 'agency'] },
          },
          {
            name: 'page',
            in: 'query',
            schema: {
              type: 'integer',
              minimum: 1,
              maximum: 999999999,
              default: 1,
            },
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string', maxLength: 120 },
          },
        ];
        operation.responses['200'] = {
          description:
            'Up to twelve published profiles per professional type in the selected region',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items', 'hasMore', 'counts'],
                properties: {
                  hasMore: { type: 'boolean' },
                  counts: {
                    type: 'object',
                    required: ['agent', 'agency'],
                    properties: {
                      agent: { type: 'integer', minimum: 0 },
                      agency: { type: 'integer', minimum: 0 },
                    },
                  },
                  items: {
                    type: 'array',
                    maxItems: 24,
                    items: {
                      type: 'object',
                      required: ['id', 'name', 'kind'],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        kind: { type: 'string', enum: ['agent', 'agency'] },
                      },
                    },
                  },
                },
              },
            },
          },
        };
      }
      if (operationId === 'get /v1/search/region-counts') {
        operation.responses['200'] = {
          description: 'Published listing counts by configured region',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['items'],
                properties: {
                  items: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: ['code', 'count'],
                      properties: {
                        code: { type: 'string' },
                        count: { type: 'integer', minimum: 0 },
                      },
                    },
                  },
                },
              },
            },
          },
        };
      }
      if (operationId === 'post /v1/search/map') {
        operation.responses['201'] = {
          description:
            'Map markers for eligible public listings in the requested area',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['markers', 'matched', 'truncated'],
                properties: {
                  markers: {
                    type: 'array',
                    items: {
                      type: 'object',
                      required: [
                        'id',
                        'count',
                        'longitude',
                        'latitude',
                        'minPrice',
                        'listingIds',
                      ],
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        count: { type: 'integer', minimum: 1 },
                        longitude: { type: 'number' },
                        latitude: { type: 'number' },
                        minPrice: { type: 'number' },
                        listingIds: {
                          type: 'array',
                          items: { type: 'string', format: 'uuid' },
                        },
                      },
                    },
                  },
                  matched: { type: 'integer', minimum: 0 },
                  truncated: { type: 'boolean' },
                  extent: {
                    type: 'array',
                    nullable: true,
                    minItems: 4,
                    maxItems: 4,
                    items: { type: 'number' },
                    description:
                      'West, south, east, north of all eligible listings before clustering. Null when empty or truncated. A single location has equal lower and upper coordinates.',
                  },
                },
              },
            },
          },
        };
      }
      if (operationId === 'get /v1/search/locations') {
        operation.parameters = [
          {
            name: 'kind',
            in: 'query',
            required: true,
            schema: { type: 'string', enum: ['city', 'metro'] },
          },
          {
            name: 'q',
            in: 'query',
            schema: { type: 'string', maxLength: 100 },
          },
          { name: 'regionCode', in: 'query', schema: { type: 'string' } },
          {
            name: 'locality',
            in: 'query',
            schema: { type: 'string', maxLength: 150 },
          },
        ];
      }
      if (operationId === 'get /v1/search/sitemap') {
        operation.parameters = [
          ...(operation.parameters ?? []).filter(
            (parameter: ParameterObject | ReferenceObject) =>
              !(
                'in' in parameter &&
                parameter.in === 'query' &&
                parameter.name === 'after'
              ),
          ),
          {
            in: 'query',
            name: 'after',
            required: false,
            description:
              'Exclusive UUID cursor from sitemap partitions; at most 49,999 eligible listings per page.',
            schema: { type: 'string', format: 'uuid' },
          },
        ];
        operation.responses['200'] = {
          description: 'Live eligible listing sitemap page',
          content: {
            'application/json': {
              schema: {
                type: 'array',
                maxItems: 49999,
                items: {
                  type: 'object',
                  required: ['id', 'published_at'],
                  properties: {
                    id: { type: 'string', format: 'uuid' },
                    published_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
          },
        };
      }
      if (
        method === 'post' &&
        [
          '/v1/auth/verification/phone',
          '/v1/auth/verification/phone/confirm',
          '/v1/auth/verification/phone/otp',
          '/v1/auth/verification/phone/otp/confirm',
        ].includes(path)
      ) {
        const conflict = operation.responses['409'];
        if (conflict && 'description' in conflict) {
          conflict.description +=
            '. contact_phone_required means replacing the primary number would remove the last number for a calls-only listing. Choose a replacement on that listing or enable messages before retrying.';
        }
      }
      if (operationId === 'get /v1/search/sitemap/partitions') {
        operation.responses['200'] = {
          description: 'Live keyset boundaries; not a cross-request snapshot',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['pageSize', 'cursors'],
                properties: {
                  pageSize: { type: 'integer', enum: [49999] },
                  cursors: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string', format: 'uuid', nullable: true },
                  },
                },
              },
            },
          },
        };
      }
    }
  return document;
}
