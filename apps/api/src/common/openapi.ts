import { aiRequest, flagRequest } from '../modules/ai/contracts';
import { trustDecision, duplicateDecision } from '../modules/trust/trust';
import { analyticsEvent } from '../modules/analytics/analytics';
import {
  feedInput,
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
  loginSchema,
  passwordSchema,
} from '../modules/auth/auth';
import { uploadSchema } from '../modules/media/media';
import { createSchema } from '../modules/properties/properties';
import { fields } from '../modules/listings/listings';
import { addressSchema } from '../modules/geo/geo';
import { staffPermissions, uuid } from './security';
const object = (shape: z.ZodRawShape) => z.object(shape).strict();
const version = z.number().int().positive();
const name = z.string().min(1).max(200);
const bodyContracts: Record<string, z.ZodType> = {
  'post /v1/ai/assist': aiRequest,
  'patch /v1/admin/ai/features/{code}': flagRequest,
  'post /v1/trust/listings/{id}/scan': object({}),
  'post /v1/admin/trust/listings/{id}/decision': trustDecision,
  'post /v1/admin/trust/candidates/{id}/decision': duplicateDecision,
  'post /v1/analytics/events': analyticsEvent,
  'post /v1/organizations/{organizationId}/feeds': feedInput,
  'post /v1/organizations/{organizationId}/feeds/{feedId}/dry-run': importInput,
  'post /v1/organizations/{organizationId}/feeds/{feedId}/apply': importInput,
  'patch /v1/organizations/{organizationId}/feeds/{feedId}': feedConfig,
  'patch /v1/admin/integrations/feeds/{id}': feedConfig,
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
    address: addressSchema.optional(),
  }),
  'post /v1/listings': object({
    propertyId: uuid,
    dealType: z.enum(['sale', 'long_rent', 'short_rent']),
    title: fields.title.default(''),
    price: fields.price.optional(),
    description: fields.description.default(''),
    terms: fields.terms.default({}),
  }),
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
get /v1/media/{id}/{variant}
get /v1/search/sitemap
get /v1/search/sitemap/partitions
post /v1/search
post /v1/search/selection
post /v1/search/map
post /v1/geo/layers
post /v1/commerce/webhook
post /v1/auth/register
post /v1/auth/login
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
      if (operationId === 'get /v1/account/publication-quota') {
        const required = ['applies', 'limit', 'publishedObjects', 'remaining'];
        operation.description =
          'Own-account informational capacity. Owners count distinct published Property IDs, across all sources; drafts and nonpublic offers consume no slots. Multiple offers for one Property count once. Existing over-limit publications are preserved. This snapshot does not reserve publication capacity.';
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
                      limit: { type: 'integer', enum: [6] },
                      publishedObjects: { type: 'integer', minimum: 0 },
                      remaining: { type: 'integer', minimum: 0, maximum: 6 },
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
                }
              : {}),
          },
        };
        operation.responses[operationId.startsWith('post') ? '201' : '200'] = {
          description: 'Account identity; public_id is informational only',
          content: {
            'application/json': {
              schema:
                operationId === 'post /v1/auth/login'
                  ? {
                      type: 'object',
                      required: ['user', 'csrfToken'],
                      properties: {
                        user: userSchema,
                        csrfToken: { type: 'string' },
                        sessionToken: {
                          type: 'string',
                          description: 'Bearer transport only',
                        },
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
