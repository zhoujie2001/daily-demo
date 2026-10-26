# Dispatch root-batch capacity: 40 items / 2 cards

## Incident and scope

On 2026-10-26 at 14:01:29 Asia/Shanghai, production `automation-send` rejected
Base source record `reczz28RvtLB4AsO` with HTTP 400 / `INVALID_BATCH_SIZE`.
The original batch `ad-bess-d-f39826580b040debc958b81b` contained 32 items
(sheet rows 14952–14983). Validation required at most 30 items and ran before
card splitting. The function took 47ms; this rejection was not a DB timeout.

This patch fixes the Vercel repository. It does not change FaaS, an Aime Skill,
Base Workflow configuration, credentials, roster/cursor rules, or production data.
The incident already used a direct-delivery fallback; do not replay it to test
this patch.

## Bounded contract

`lib/dispatch/batch-limits.js` is the single source of the related limits:

| Boundary | Limit |
| --- | --- |
| Root request to `/send` or `/automation-send` | 1–40 items |
| Each generated card | At most 20 items |
| Generated cards per root batch | At most 2 |

Examples: 30 → 20+10; 31 → 20+11; 32 → 20+12; 40 → 20+20.
Legacy callback validation and individual assignment limits are unchanged. The
two split-aware ingress handlers explicitly opt in with `splitCards: true`.
Other internal callers retain the original 30-item normalization limit; a field
in the request body cannot opt them in. In particular, Base Pull still builds a
legacy single card and must reject 31–40 before handoff rather than silently
creating an oversized card. Migrating Pull to the root-reserved split protocol
is separate work and is **not claimed complete** by this release.

The existing status aggregator expects at most two cards, so raising the ingress
limit beyond 40 is **not** supported by this patch. The automation endpoint's
independent 64 KiB request-body budget remains enforced, including Base64 overhead.

The root `batch_id`, root fingerprint/reservation, child batch IDs, operation IDs,
Queue schema and sending UUID derivation are unchanged. The same root key cannot
change its item list or split plan: 30↔32, 32↔40 and 32→20 return 409
`PAYLOAD_CONFLICT`, without publishing new child tasks.

No SQL migration is needed: the existing root-reservation RPC accepts a JSON
request-ID list and chunk plan without a 30-item constraint. No DB ACL changes
or control toggles are part of this patch.

## Explicit validation rejection

Both ingress endpoints return HTTP 400 for 0 or >40 items, before store creation,
root reservation, handoff or Queue publication. The response retains the original
error and adds only non-sensitive diagnostic fields, for example:

```json
{
  "ok": false,
  "error_code": "INVALID_BATCH_SIZE",
  "accepted": false,
  "retryable": false,
  "message": "批量派单需求数必须为 1 至 40 条",
  "item_count": 41,
  "limits": {
    "min_items": 1,
    "max_items": 40,
    "max_items_per_card": 20,
    "max_card_count": 2
  }
}
```

`automation-send` also retains `source_record_id`. The same fields appear in
validation-error logs; payloads, credentials and names are not added to logs.
These flags describe rejection of **this request**, not absence of an earlier
accepted operation with the same key. Queue/network uncertainty and existing
handoff recovery semantics are unchanged.

Caller/Workflow integration must preserve `http_status`, `error_code`, `message`
and the counts in its audit/error fields. Do not poll a deterministic 400 until
`POLL_TIMEOUT`, treat a computed operation ID as acceptance, automatically reset
FAILED→PENDING, or use this rejection as permission to resend an older batch.
This repository cannot update the remote Skill or Workflow automatically.

## Local verification and release

`tests/dispatchBatchCapacity.test.js` uses only in-memory DB/Queue/receipt
fixtures. It exercises the real handlers and validation code, covering:

- AD, 千川 and 本地推, 1/20/21/30/31/32/40 items through both ingress endpoints.
- 0/41-item rejection with zero persistence/publication and explicit evidence.
- Base64 payloads, dry-run parity and zero-side-effect planning.
- Status-first `NOT_FOUND` → 32-item handoff → cross-ingress idempotent replay.
- One confirmed card / one unknown card stays `SENDING`; only two receipt
  fixtures with message IDs produce aggregate `SENT` in both status APIs.
- Root-payload drift does not create more cards.
- Legacy Base Pull retains its previous 30-item limit, rejecting 31/32/40 before
  any handoff, publication or Base writeback; the 30-item path remains unchanged.

These tests are not live Feishu delivery or real Supabase acceptance evidence.
On 2026-10-26 the full suite passed **977/977**, with **50/50** capacity/chunk/Pull
focused tests, ESLint, Vite build and `git diff --check` passing. The first
sandboxed full-suite attempt could not connect to its local HTTP fixture
(`EACCES 127.0.0.1`); the full suite was rerun successfully with local loopback
access. No production sends, data changes or deployment were performed.

Review/merge/deploy separately. After deployment, first use a new **dry-run**
test batch to check 32 → 20+12 and 41 → 400; live sending requires a separately
approved test batch and group. Never reuse the incident batch for a canary.
Rollback is an application revert; already accepted child tasks remain durable
and must not be deleted or resent.
