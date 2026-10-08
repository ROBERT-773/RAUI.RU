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
import { uuid } from './security';
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

  'post /v1/auth/register': registerSchema,
  'post /v1/auth/login': loginSchema,
  'post /v1/auth/verification/phone': object({
    phone: z.string().regex(/^\+[1-9][0-9]{7,14}$/),
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
  `post /v1/organizations
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
