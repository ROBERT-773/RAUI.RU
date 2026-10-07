# Product gap backlog

This document organizes a read-only product audit into bounded follow-up tasks.
It does not authorize implementation, provider changes, or production changes.
Requirements come from `RAUI_TZ_v1.0.md` sections 4, 6 and 11 and
`PRODUCT_QUALITY_ITERATION_SPEC.md` (filter consistency, URL integrity, saved
searches, accessibility and regression evidence). Follow-up work must respect
the phase boundaries in `RAUI_MASTER_EXECUTION_PLAN.md`.

## Evidence and confidence

- **User-observed:** saved-search cards show a name without a filter summary.
  Opening a generic `/search` route showed blank filters. The user did not yet
  demonstrate restoration through the saved card's actual link. Do not report
  that observation as a proven persistence or restoration failure.
- **Code-supported:** `apps/web/components/account.tsx:398` encodes the stored
  definition in the saved-search link; `apps/web/app/search/page.tsx:12` parses
  it. `apps/api/src/modules/product/product.ts:31` validates saved definitions
  without a pagination cursor, and line 103 persists them. There is an existing
  saved-link browser regression in `apps/web/e2e/product.spec.ts:236` that checks
  restored price and filtered results at line 283. It was inspected, not rerun
  during this audit.
- **Code-supported, runtime regression not yet added:**
  `apps/web/components/search.tsx:24` initializes definition, mode and category
  from props only once. The route at `apps/web/app/search/page.tsx:25` supplies
  new props without a changing component key. Same-route navigation that keeps
  the component mounted can therefore leave executed state stale. Actual Next
  router behavior needs browser reproduction before claiming a confirmed bug.
- **Code-supported deterministic serialization defect:**
  `apps/web/components/search.tsx:187` and line 201 display only room/area minima;
  submission at line 102 converts rooms to an exact value and area to a minimum.
  A valid restored definition containing `rooms: { min: 2, max: 4 }` and
  `area: { min: 50, max: 80 }` changes to rooms 2–2 and loses the area maximum
  after unchanged submission. A maximum-only rooms range disappears.
- **Code-supported missing presentation:** search saving at
  `apps/web/components/search.tsx:72` names searches using their query or
  “Мой поиск”; cards at `apps/web/components/account.tsx:395` show the name and
  actions but no filter summary. Stored definitions still contain the filters.
- **Code-supported lifecycle risk, runtime regression not yet added:**
  `apps/web/components/advanced-filters.tsx:52` loads category fields
  asynchronously, retains previous fields until completion and silently catches
  failure at line 60. Submission reconstructs attributes from rendered form
  fields at `apps/web/components/search.tsx:100`. Loading, failure and category
  changes need deferred-response regressions to establish attribute-loss paths.

Audit verification:

```sh
PATH=/workspace/.raui-tools/node_modules/.bin:$PATH pnpm --filter @raui/web test components/search.test.tsx components/account.test.tsx
```

Result: two test files and 16 tests passed. The search unit tests currently cover
loading, empty results and error retry; they do not establish range preservation
or navigation synchronization. This is not a full release-gate verification.

## Task 1 — URL restoration and room/area range preservation

Priority: P1. Grounding: TZ section 4 stable URLs and saved searches; quality spec
filter consistency and URL integrity.

Scope: first reproduce navigation between different `/search?definition=...`
URLs without a full reload. Keep executed definition, visible fields, category
and mode consistent with the current URL. Preserve supported room/area ranges
when the user submits unchanged restored filters. Avoid redesigning the entire
filter product or changing saved-search storage.

Acceptance criteria:

- A regression demonstrates the behavior of mounted same-route navigation,
  including browser back/forward where applicable; the final test asserts URL,
  visible filter values and the submitted search definition agree.
- Opening the actual saved-search link restores its supported filters and
  executes the matching definition; generic `/search` remains a default search.
- Unchanged submission preserves room and area min-only, max-only and bounded
  ranges. Editing and clearing those filters produce deliberate definitions.
- The existing saved-search price/result browser journey remains green.

File ownership: this task owns `apps/web/components/search.tsx`,
`apps/web/components/search.test.tsx`, `apps/web/app/search/page.tsx` and relevant
search/saved-link cases in `apps/web/e2e/product.spec.ts`. Coordinate any edits to
`advanced-filters.tsx` with Task 3 rather than assigning concurrent writers.

## Task 2 — Readable saved-search cards

Priority: P2. Grounding: TZ section 11 saved searches; quality spec conversion
flows and accessibility.

Scope: add a localized, readable summary derived from the existing stored
definition. Summaries must distinguish searches with identical generic names.
Keep rename, reopen and deletion behavior intact. A new save-name dialog,
subscriptions and storage changes are outside this task.

Acceptance criteria:

- Cards summarize populated property/deal type, location, price and room/area
  filters, and represent remaining supported active filters without implying
  their absence. Empty definitions have an explicit default-search description.
- Summaries preserve range meaning, escape user text and handle omitted fields
  without undefined values or crashes.
- Tests cover two same-name searches with different definitions and ensure
  summary rendering does not change the encoded reopen definition.
- Rename and delete regressions continue to pass; narrow mobile layouts retain
  readable summaries and accessible actions.

File ownership: `apps/web/components/account.tsx`,
`apps/web/components/account.test.tsx` and a dedicated summary helper/test if
needed. Avoid editing `search.tsx` or the search E2E file owned by Task 1.

## Task 3 — Advanced-filter loading and category lifecycle

Priority: P2. Grounding: TZ section 4 configurable filters; quality spec filter
consistency and accessible form errors.

Scope: reproduce and fix submission during field loading, failed field requests
and category changes. Make pending/error/retry states visible. Ensure unrendered
saved attributes are not silently discarded and previous-category controls
cannot accidentally become the next category's applied filters.

Acceptance criteria:

- Deferred-request tests prove that unchanged saved attributes survive loading
  and failed loads, or submission is explicitly blocked until safe completion.
- Failed category lookup exposes an accessible error and working retry.
- Rapid category changes reject obsolete results. Old-category fields cannot
  be submitted accidentally; any incompatible-filter removal is intentional and
  visible to the user.
- Successful loading restores saved advanced values; clearing a loaded field
  removes that filter deliberately.
- Existing basic search submission and saved-search journeys remain green.

File ownership: `apps/web/components/advanced-filters.tsx` and a dedicated
`apps/web/components/advanced-filters.test.tsx`. Integration changes in
`search.tsx` must be coordinated with Task 1 and applied sequentially.

## Separate decision — City/address suggestions

The search query and locality controls are ordinary inputs at
`apps/web/components/search.tsx:122` and line 181. Locality filtering is exact
match in `apps/api/src/modules/search/contracts.ts:90` and
`apps/api/src/modules/search/search.ts:100`. This supports a usability concern,
not a confirmed autocomplete regression.

TZ section 6 explicitly requires address/autocomplete for listing creation;
section 4 requires locality search but does not explicitly mandate search
autocomplete. Treat search suggestions as a separate product/access/provider
decision, not as an implied fix in the three tasks above.

The existing adapter is `Geocoder` / `HttpGeocoder` in
`apps/api/src/modules/geo/geo.ts:23`. It validates provider results, times out
after three seconds and returns unavailable when no provider is configured.
The `/v1/geo/geocode` endpoint at line 73 is authenticated; no web consumer was
found. Before implementation, decide the suggestion source, canonical locality
mapping, guest access, provider configuration and unavailable-provider fallback.
A future UI must support keyboard selection and stale-request handling. Do not
expose the existing authenticated endpoint publicly or invent a provider as
part of this documentation task.
