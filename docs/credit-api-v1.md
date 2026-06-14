# TRADR Credit API v1

**Base URL:** `https://tradr-webhook.onrender.com/api/v1`  
**API Version Header:** `X-TRADR-API-Version: 2026-06-09`

This guide covers everything an MFB backend developer needs to integrate with the TRADR Credit API in a single afternoon.

---

## Authentication

All endpoints require a partner API key issued by TRADR.

```
Authorization: Bearer <your-api-key>
```

Keys are 64-character hex strings. The server stores only a SHA-256 hash — raw keys cannot be recovered after issuance.

**Error responses:**

| Status | Code | Meaning |
|--------|------|---------|
| 401 | `missing_credentials` | No `Authorization` header |
| 401 | `invalid_api_key` | Key not recognised |
| 401 | `partner_suspended` | Partner account suspended |
| 429 | `rate_limit_exceeded` | Over your per-minute limit |

---

## Rate Limits

Default: **60 requests/minute** per partner. Limits are enforced with a sliding 60-second window. Contact TRADR to request a higher limit.

---

## Error Format

All errors use this envelope:

```json
{
  "error": {
    "code": "snake_case_code",
    "message": "Human-readable description"
  }
}
```

---

## Endpoints

### 1. Get Trader Assessment

```
GET /api/v1/traders/{trader_id}/assessment
```

Computes the trader's current TRADR Score, evaluates loan readiness, and returns a full credit profile. Every call creates an immutable snapshot in our audit log and returns its ID.

**Path parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `trader_id` | string | TRADR-assigned trader identifier |

**Response `200 OK`:**

```json
{
  "assessment_id": "asmt_3f8a1b2c4d5e6f7a",
  "trader_id": "abc123",
  "partner_id": "your_partner_id",
  "generated_at": "2026-06-09T10:30:00.000Z",
  "score": {
    "value": 612,
    "tier": "Established",
    "components": {
      "recording_consistency": { "score": 22, "max": 30 },
      "transaction_volume":    { "score": 18, "max": 25 },
      "business_stability":    { "score": 16, "max": 20 },
      "digital_payment_ratio": { "score": 11, "max": 15 },
      "expense_management":    { "score":  5, "max":  5 },
      "profile_completeness":  { "score":  5, "max":  5 }
    }
  },
  "loan_ready": true,
  "loan_ready_conditions": {
    "score_met":       true,
    "history_met":     true,
    "consistency_met": true,
    "volume_met":      true
  },
  "days_recording": 78,
  "active_days_last_30": 22,
  "monthly_revenue": {
    "this_month_band": "50k-150k",
    "last_month_band": "50k-150k"
  },
  "bureau": {
    "bvn_verified":          true,
    "credit_check_performed": true,
    "overdue_loans":          false
  },
  "reason_codes": [
    "Recorded sales 22 of last 30 days — strong consistency",
    "78 days of trading history on record",
    "Monthly revenue meets ₦50,000 minimum threshold",
    "Active in 7 of last 8 weeks — stable trading pattern",
    "42% of sales digitally verified — more bank transfers would improve score",
    "Expense ratio 36% of revenue — well managed",
    "BVN verified",
    "Credit bureau check on file",
    "No overdue loans on bureau record"
  ]
}
```

**Score field notes:**

- `score.value` — TRADR Score on a 0–850 scale (mirrors Nigerian credit bureau conventions)
- `score.tier` — `Building` / `Growing` / `Established` / `Trusted`
- `loan_ready` — `true` only when all four conditions in `loan_ready_conditions` are met
- `monthly_revenue` — returned as bands (`<50k`, `50k-150k`, `150k-300k`, `300k-500k`, `500k+`) to protect trader privacy; internal dashboard partners receive exact NGN figures
- `reason_codes` — plain-English strings intended for a credit officer; mix of positive factors and blockers
- `bureau.bureau_score` — included for internal partners only when a bureau check is on file

**Loan-ready thresholds (fixed — do not change without TRADR approval):**

| Condition | Threshold |
|-----------|-----------|
| TRADR Score | ≥ 500 / 850 |
| Trading history | ≥ 60 days |
| Active days (last 30) | ≥ 15 days |
| Monthly revenue | ≥ ₦50,000 (this or last month) |

**Error responses:**

| Status | Code | Meaning |
|--------|------|---------|
| 403 | `consent_required` | Trader has not granted data access to your partner account |
| 404 | `trader_not_found` | Trader ID does not exist |
| 503 | `service_unavailable` | Downstream data fetch failed |

---

### 2. Retrieve Assessment Snapshot

```
GET /api/v1/assessments/{assessment_id}
```

Returns a previously generated assessment snapshot exactly as it was at the time of creation. Snapshots are immutable — they are never updated or deleted, making them suitable as audit evidence.

You may only retrieve assessments your partner generated.

**Path parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `assessment_id` | string | ID from a prior `GET /traders/:id/assessment` response |

**Response `200 OK`:** Same schema as the assessment creation response above.

**Error responses:**

| Status | Code | Meaning |
|--------|------|---------|
| 403 | `forbidden` | Assessment belongs to a different partner |
| 404 | `assessment_not_found` | ID does not exist |

---

## Consent

Trader data access requires explicit consent from the trader. If you request an assessment for a trader who has not consented to sharing data with your partner account, you will receive:

```json
{
  "error": {
    "code": "consent_required",
    "message": "Trader has not granted data access to this partner"
  }
}
```

Contact TRADR to initiate the consent collection flow for a trader. Consent is collected via WhatsApp and stored against the trader's profile.

*Note: Internal TRADR system integrations (e.g., the MFB dashboard) bypass this check.*

---

## TRADR Score Components

The TRADR Score is a 0–850 composite score built from six components:

| Component | Max pts | What it measures |
|-----------|---------|-----------------|
| Recording Consistency | 30 | Days with recorded activity in the last 30 days, with a trend bonus for improvement vs the prior 30 days |
| Transaction Volume | 25 | Verified monthly revenue vs a ₦150k benchmark; SMS and bank-feed records carry full weight, manual records 70% |
| Business Stability | 20 | Income variance (coefficient of variation) over 8 weekly windows |
| Digital Payment Ratio | 15 | Share of sales verified via SMS alerts or bank transfers in the last 60 days |
| Expense Management | 5 | Expenses as a percentage of last-30-day revenue |
| Profile Completeness | 5 | Onboarding fields completed |

Raw score (/100) × 8.5 = Public score (/850). BVN verification adds a +3 raw point bonus (≈ +25 on the public scale).

---

## Usage and Billing

Every API call is logged against your partner account. Assessment computation calls are metered at ₦20 per call (unit_price: 2000 kobo). Assessment retrieval calls are free. Invoicing is handled separately — there is no payment integration in the API itself.

---

## Quick-Start Example

```bash
# Get an assessment for trader abc123
curl -s \
  -H "Authorization: Bearer YOUR_API_KEY" \
  https://tradr-webhook.onrender.com/api/v1/traders/abc123/assessment \
  | jq '{score: .score.value, loan_ready: .loan_ready, id: .assessment_id}'

# Retrieve the snapshot later
curl -s \
  -H "Authorization: Bearer YOUR_API_KEY" \
  https://tradr-webhook.onrender.com/api/v1/assessments/asmt_3f8a1b2c4d5e6f7a
```

---

## Onboarding Checklist

1. TRADR issues your API key via `scripts/createPartner.js` — receive it securely
2. Store the raw key in your secrets manager (it cannot be recovered from TRADR)
3. Send `Authorization: Bearer <key>` on every request
4. For external lender integrations: ensure traders have consented before calling the assessment endpoint
5. Store `assessment_id` from each response — use it for audit trail and loan-file documentation
