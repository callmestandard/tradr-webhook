# TRADR Server — Data Model

_Last updated: 2026-06-12. Schema version: 1._

All new collections carry four global-ready fields:
`country` (default `'NG'`), `currency` (default `'NGN'`),
`timezone` (default `'Africa/Lagos'`), `schema_version` (integer, start `1`).
Money in new collections is stored as **integer kobo** (minor units).
Existing transaction amounts remain in naira (legacy — do not migrate).

---

## Collections

### `traders/{traderId}`
Trader profile. Source of truth for identity, score snapshot, consent, and push token.

| Field | Type | Notes |
|---|---|---|
| `businessName` | string | Trader-entered business name |
| `whatsappNumber` | string | International format e.g. `2348012345678`. Never logged. |
| `tradrScore` | number | Cached /850 score, updated on nightly agent run |
| `tier` | string | `Building/Growing/Established/Trusted` |
| `bvnVerified` | boolean | Set by `/bureau/verify-bvn` |
| `creditData` | object | Bureau check result from Zeeh Africa |
| `apiConsent` | object | `{ granted, partners: [], lastUpdated }` |
| `pushToken` | string | Expo push token for loan notifications |
| `telegramChatId` | string | Linked Telegram chat ID |
| `whatsappOptOut` | boolean | |

**Retention:** Permanent while account is active. Deleted on `POST /account/delete`.

---

### `traders/{traderId}/transactions/{txId}`
Every transaction recorded by this trader (sales, expenses).

| Field | Type | Notes |
|---|---|---|
| `id` | string | Matches document ID |
| `type` | string | `sale` or `expense` |
| `amount` | number | **Naira** (legacy — not kobo) |
| `description` | string | Human-readable label |
| `source` | string | Ingestion path — see Verification Tiers below |
| `verification` | object | `{ tier, source, stamped_at, schema_version }` — server-assigned, never client-trusted |
| `createdAt` | number | Unix ms UTC |
| `paymentMethod` | string? | `transfer`, `cash`, etc. |

**Immutability:** Transactions are append-only. Never update or delete individual records.

---

### `pending_transactions/{txId}`
Transactions waiting for the mobile app to auto-approve on next open.

Same fields as `traders/*/transactions` plus:

| Field | Type | Notes |
|---|---|---|
| `userId` | string | Trader ID |
| `status` | string | `pending` → app sets to `approved` |
| `monoTransactionId` | string? | Dedup key for Mono webhook |
| `slug` | string? | TradrLink slug (customer_link source) |

---

### `passports/{passportId}`
Immutable snapshot of a trader's financial identity at a point in time.

| Field | Type | Notes |
|---|---|---|
| `passport_id` | string | `pp_` + 20 hex chars. Matches document ID. |
| `trader_id` | string | |
| `issued_at` | number | Unix ms UTC |
| `expires_at` | number | `issued_at + 30 days` |
| `revoked` | boolean | Set to `true` by `revokePassport()`. Never deleted. |
| `business_name` | string | Snapshot — does not update if trader changes name |
| `score` | number | /850 at time of issue |
| `tier` | string | |
| `months_recording` | number | |
| `active_days_30` | number | |
| `revenue_band` | string | Band string — never exact naira |
| `bvn_verified` | boolean | |
| `dq_band` | string | `high/medium/low` — data verification band |
| `country` | string | `NG` |
| `currency` | string | `NGN` |
| `timezone` | string | `Africa/Lagos` |
| `schema_version` | number | `1` |

**Immutability:** Passports are write-once. Regeneration creates a new document — the old one is never modified except `revoked` flag.
**Rate limit:** Max 3 per trader per calendar day.
**PII:** No phone, BVN, or contact details stored. Business name only.

---

### `exports_audit/{autoId}`
Audit log for every export download. Written by `GET /export/:token`.

| Field | Type | Notes |
|---|---|---|
| `trader_id` | string | |
| `type` | string | `csv` or `pdf` |
| `requested_via` | string | `whatsapp_bot`, `download_link`, etc. |
| `downloaded_at` | number | Unix ms UTC |
| `ip` | string | Partial IP only — last octet replaced with `xxx` |
| `country` | string | `NG` |
| `currency` | string | `NGN` |
| `timezone` | string | `Africa/Lagos` |
| `schema_version` | number | `1` |

**Retention:** 90 days. No PII (partial IP only).

---

### `growth_touches/{autoId}`
Analytics event logged each time a non-user receives an outbound TRADR message.

| Field | Type | Notes |
|---|---|---|
| `surface` | string | `debt_reminder`, `whatsapp_receipt`, `tradrlink_page` |
| `trader_id` | string? | Null for anonymous surfaces (TradrLink) |
| `timestamp` | number | Unix ms UTC |
| `country` | string | `NG` |
| `currency` | string | `NGN` |
| `timezone` | string | `Africa/Lagos` |
| `schema_version` | number | `1` |

**Retention:** 1 year. No PII — debtor phone numbers are never logged here.

---

### `partner_leads/{autoId}`
Interest submissions from the passport verify page's lender CTA.

| Field | Type | Notes |
|---|---|---|
| `name` | string | Contact name |
| `organization` | string | Institution name |
| `email` | string? | Optional |
| `phone` | string? | Optional |
| `source` | string | `passport_verify_page` |
| `created_at` | number | Unix ms UTC |
| `country` | string | `NG` |
| `schema_version` | number | `1` |

---

## Existing collections (cross-reference)

| Collection | Purpose | Managed by |
|---|---|---|
| `assessments/{assessmentId}` | Immutable Credit API snapshots | `routes/api/v1/traders.js` |
| `api_usage/{autoId}` | Per-call metered billing log | `routes/api/v1/traders.js` |
| `consent_requests/{requestId}` | WhatsApp data-sharing consent flow | `routes/api/v1/traders.js`, `routes/whatsapp.js` |
| `loanApplications/{appId}` | Full credit file per application | Mobile app + MFB dashboard |
| `loan_repayments/{appId}/schedule/{id}` | Monthly repayment schedule | MFB dashboard |
| `mono_accounts/{accountId}` | Mono bank link mapping | `routes/mono.js` |
| `tradr_links/{slug}` | TradrLink slug → userId registry | `routes/index.js` |
| `nightly_runs/{autoId}` | Nightly agent run logs | `routes/agent.js` |
| `bureau_checks/{traderId}` | BVN + bureau check results | `routes/bureau.js` |

---

## Verification Tiers

Server assigns tier to every transaction at ingestion time based on `source` field.
Client-supplied tier is never trusted.

| Tier | Weight | Sources |
|---|---|---|
| `bank_verified` | 1.0 | `mono_auto` |
| `payment_confirmed` | 0.95 | `customer_link` |
| `sms_parsed` | 0.9 | `sms_agent` |
| `bot_recorded` | 0.7 | `whatsapp_bot`, `telegram_bot` |
| `manual` | 0.6 | `app_manual`, `quick_sale`, unknown |

`data_quality_ratio = Σ(amount × weight) / Σ(amount)` across all transactions.
Exposed in Credit API assessment as `data_verification.{ ratio, band, breakdown_by_tier }`.
Band: `high` ≥ 0.8, `medium` 0.5–0.79, `low` < 0.5.

---

## Growth footer surfaces

Footer appended by `services/growthFooter.js`:

| Surface | File | Language |
|---|---|---|
| Debt reminder WhatsApp | `utils/whatsapp.js:sendDebtReminder` | Matches reminder language param |
| Sale/expense receipt reply | `routes/whatsapp.js` | `en` (default) |
| TradrLink payment page | `index.js:/pay/:slug` | HTML CTA block |

**Never appended to:** loan decision messages, consent requests, MFB push notifications, admin messages.
