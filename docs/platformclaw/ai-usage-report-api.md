---
summary: "Intranet API for monthly employee and model usage reporting without application tokens"
read_when:
  - Integrating PlatformClaw into a corporate AI usage collector
  - Implementing monthly employee or model usage exports
title: "AI usage report API contract"
---

# AI usage report API contract

The report and account-search endpoints are assembled by the standard Control
Plane runtime on its existing Web listener. No additional token, account,
enable flag, or port is required. Deploy a build containing this API, allow the
collector through the corporate firewall, and query the existing server address.

This contract lets a corporate collector ingest PlatformClaw alongside other AI
applications. It preserves the existing six reporting fields and adds optional
model grouping. The application API requires no token, API key, or browser login.
The deployment limits access to its approved corporate network using network or
reverse-proxy rules. No operator credential is supplied to the collector.

The companion `docs/platformclaw/ai-usage-report-api.openapi.json` describes the
same contract in [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html) format for
API tooling. Its server address is a placeholder.

## Common tasks

Use `/platformclaw/api/v1/reports/ai-usage` as the base path. The examples below
target a deployed build containing this API.

| Task                                 | Query string                                                      |
| ------------------------------------ | ----------------------------------------------------------------- |
| Everyone this month                  | No parameters needed.                                             |
| One person this month                | `?knox_id=person.one`                                             |
| One person last month                | `?knox_id=person.one&period=last_month`                           |
| One person in a particular month     | `?knox_id=person.one&month=2026-10`                               |
| One person's monthly model detail    | `?knox_id=person.one&month=2026-10&group_by=model`                |
| Several people together              | `?knox_id=person.one,person.two&month=2026-10`                    |
| One department this year             | `?team=Example%20Engineering&period=this_year`                    |
| One person's last three months       | `?knox_id=person.one&period=last_3_months`                        |
| Filter a provider and model          | `?provider=example-provider&model=example-model-a&group_by=model` |
| Top ten users this month             | `?sort=token_usage&order=desc&limit=10`                           |
| Download a person's report for Excel | `?knox_id=person.one&month=2026-10&format=csv`                    |

For a usage ranking across people, use the default `group_by=service` for a
single month; model rows or several months rank individual buckets instead.
Search by account or display name with the user lookup below when the account
is unknown. A known user with no usage returns HTTP `200`, an empty `raw_data`,
and zero totals when source collection is complete. An unknown requested
account returns `404`, so a typo cannot look like no usage.

## Request

```http
GET /platformclaw/api/v1/reports/ai-usage?start_month=2026-09&end_month=2026-10
Accept: application/json
```

| Parameter     | Required                    | Meaning                                                               |
| ------------- | --------------------------- | --------------------------------------------------------------------- |
| `month`       | No                          | One specific month in `YYYY-MM` format.                               |
| `start_month` | Together with `end_month`   | First month, inclusive, in `YYYY-MM` format.                          |
| `end_month`   | Together with `start_month` | Last month, inclusive, in `YYYY-MM` format.                           |
| `period`      | No                          | `this_month`, `last_month`, `last_3_months`, or `this_year`.          |
| `knox_id`     | No                          | One verified account or up to 100 comma-separated accounts.           |
| `team`        | No                          | Exact current department name; URL-encode spaces and punctuation.     |
| `provider`    | No                          | Exact recorded provider ID.                                           |
| `model`       | No                          | Exact recorded model ID.                                              |
| `group_by`    | No                          | `service` by default; `model` returns model detail.                   |
| `sort`        | No                          | `month` by default; also `knox_id`, `call_count`, or `token_usage`.   |
| `order`       | No                          | `asc` by default, or `desc`.                                          |
| `limit`       | No                          | Optional top-result limit from 1 to 100000. Omit for the full report. |
| `format`      | No                          | `json` by default, or `csv` for spreadsheet download.                 |

Choose at most one date selector: `month`, the `start_month`/`end_month` pair,
or `period`. With none, use the current Korean calendar month. A single range
endpoint without its partner or conflicting selectors returns `400`.
`last_3_months` includes the current month and its two predecessors;
`this_year` runs from January through the current month. Calculate relative
periods once at request start and return their resolved months in metadata.

Use `Asia/Seoul` for all month boundaries. A month starts at 00:00 on its first
day and ends immediately before the next month starts. The range must contain
1 through 12 calendar months. The current month is allowed; future months are
rejected. Reject unknown or repeated query parameters and request bodies.

For `knox_id`, accept at most 100 submitted entries, trim entries, convert to
lowercase, remove duplicate accounts, and reject empty entries. Values in this
parameter use OR; filters across parameters use AND. All requested accounts
must exist and have verified corporate accounts, or return `404` with
`error.details.unknown_knox_ids`. Filters narrow data; they never grant access
or make another account private from other allowed intranet clients.

Apply identity, department, provider, and model filters before aggregation.
`team`, `provider`, and `model` use exact case-sensitive values; an unknown value
or an empty intersection returns an empty result. Reject blank filter strings.
Provider/model filters also apply to service grouping, even though its output
provider/model fields remain null. Their null/unknown buckets appear in
unfiltered model reports, without inventing an `unknown` provider ID.

```bash
curl --fail-with-body --get \
  'https://platformclaw.example.com/platformclaw/api/v1/reports/ai-usage' \
  --data-urlencode 'start_month=2026-09' \
  --data-urlencode 'end_month=2026-10' \
  --data-urlencode 'group_by=model'
```

No `Authorization` header or session cookie is needed. The operator replaces the
example origin with the deployed intranet address. Browser cross-origin access
is not part of this server-to-server contract.

## Find a person by account or name

```http
GET /platformclaw/api/v1/reports/ai-usage/users?q=person&limit=20
```

This read-only directory helper uses the same intranet access policy. It
returns registered people with verified login accounts, including people who
have no usage. It never searches chats or exposes employee numbers, email
addresses, or credentials. A collector can use it for a person picker.

| Parameter | Default         | Meaning                                                                                                                                       |
| --------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `q`       | No search       | Case-insensitive substring search over account and display name; trim and normalize Unicode to NFC. At most 100 characters; blank is invalid. |
| `team`    | All departments | Exact current department name.                                                                                                                |
| `status`  | `all`           | `active`, `disabled`, or `all`; historical reports can include disabled users.                                                                |
| `limit`   | 20              | Page size from 1 to 100.                                                                                                                      |
| `offset`  | 0               | Nonnegative row offset, at most 9007199254740991.                                                                                             |

Combine search, team, and status using AND. Sort by `knox_id` ascending before
pagination. Unknown/repeated parameters and request bodies return `400`.
Unmatched searches return `200` with an empty `users` array. Directory failure
returns `503`, never a fabricated empty directory. Pagination is a live
directory view; concurrent profile updates may change pages.

```json
{
  "users": [
    {
      "knox_id": "person.one",
      "display_name": "Example Person",
      "team": "Example Engineering",
      "status": "active"
    }
  ],
  "meta": {
    "total": 1,
    "limit": 20,
    "offset": 0,
    "has_more": false,
    "next_offset": null
  }
}
```

`total` counts all matching directory users before pagination. `next_offset`
is `offset + users.length` when more matches exist, otherwise null. An offset
beyond the last row returns an empty array and no next offset. `display_name`
and `team` may be null. Copy the selected `knox_id` into the report request.

## Row fields

All eight keys are present in every row. The first six match the existing
corporate reporting shape. `null` means unavailable; never replace it with a
fabricated identity, model, team, or zero.

| Field         | JSON type       | Meaning                                                                              |
| ------------- | --------------- | ------------------------------------------------------------------------------------ |
| `team`        | string or null  | User department at report time; null if unavailable.                                 |
| `month`       | string          | Usage month in `YYYY-MM`, using `Asia/Seoul`.                                        |
| `knox_id`     | string          | Verified corporate login account, not employee number or display name.               |
| `ai_service`  | string          | Always `PlatformClaw`, identifying the application being measured.                   |
| `call_count`  | integer         | Number of retained model usage records in this bucket.                               |
| `token_usage` | integer or null | Sum of recorded token totals; null if any counted record lacks a usable token total. |
| `provider`    | string or null  | Recorded provider ID in model mode; null in service mode or when unknown.            |
| `model`       | string or null  | Recorded model ID in model mode; null in service mode or when unknown.               |

Counts and known token totals are nonnegative safe JSON integers, at most 9007199254740991. They are numbers, never formatted strings. IDs are case-sensitive
except `knox_id`, which uses the verified directory account in lowercase.

`ai_service` identifies the application, while `provider` and `model` identify
its underlying model service. A separate application reporting its own AWS
Claude usage keeps its own `ai_service` value. Do not rename PlatformClaw rows
to `AWS Claude`; that would mix application usage with provider billing.

## Grouping and collection

- `group_by=service`: one row per `(month, knox_id, ai_service)`; `provider` and
  `model` are null. This is the recommended input to the corporate summary.
- `group_by=model`: one row per `(month, knox_id, ai_service, provider, model)`.
  Preserve unknown provider/model buckets instead of discarding their usage.
- `team` is a directory attribute, not a stable key. Updating a department
  relabels historical months to the current department. Event-time department
  reporting requires separate department history and is outside this contract.
- Return only buckets with retained usage records. Do not generate zero rows
  for every employee/month/model combination.
- Reports have no offset pagination. Without `limit`, return the full filtered
  report or `413` above 100000 rows; retry by month, team, or selected accounts.
  With explicit `limit`, return that many sorted rows and set `meta.truncated`
  when more matches exist. This supports rankings without pretending to be a
  complete export.
- Sort by the requested field and direction, with null values last in either
  direction. Break ties by `month`, `knox_id`, `ai_service`, `provider`, then
  `model`, ascending, also null last. Use ordinal string ordering.

Collect one grouping for a particular dataset. Service totals and model detail
are alternative views of the same usage; adding both doubles the result.
For the same source snapshot, model buckets must sum to service buckets,
including unknown models. If any model token value is null, the corresponding
service token value is also null. `meta.total_tokens` summarizes the full
filtered result before a top-result limit; `meta.returned_tokens` summarizes
the returned rows. Either sum is null when its contributing rows contain null.

Use `meta.source`, `meta.group_by`, and the grouping key for unfiltered corporate
collector upserts. Store filtered views in a separate dataset keyed additionally
by normalized `meta.filters`; they must never overwrite the canonical unfiltered
summary. Identical user/month keys can have different totals under provider or
model filters. A filtered dataset can replace only its identical filter scope.
Replace a complete corporate month partition only after an unfiltered HTTP
`200` with `meta.data_status=complete` and `meta.truncated=false`. Always send
explicit calendar months for scheduled collection so a retry across midnight
does not silently change the period. Do not append repeated snapshots. An empty
month with that same status removes that month's old rows. Filtered personal or
department results may replace only the same selected scope, never everyone
else's month. Keep partial or truncated reports
separate from accepted reports so they do not erase previously accepted data.
No immutable snapshot ID or cursor is promised;
two successive requests may observe different usage.

## Counting and coverage

`call_count` counts persisted model records carrying normalized usage data.
It is not user prompts, conversations, tool calls, or all provider HTTP attempts.
Failed attempts without a usage record and transport retries are not inferred.
The metadata declares `call_count_basis=usage_records` so the collector can
distinguish this metric from another application's request count.

`token_usage` uses the recorded provider total when available. Otherwise use the
normalized input + output + cache-read + cache-write components, without
counting the same category twice. Declare
`token_usage_basis=provider_total_or_components`. Zero is valid only for an
explicitly known zero; unknown component coverage must not silently become zero.
Without a provider total, both input and output counts must be recorded; absent
cache buckets follow the existing normalized zero-default convention. A missing
input or output count makes the affected total unknown, even when another
component is positive.
Transcript messages written only for display or delivery do not count as usage
records. A recorded model reply without token measurements still contributes to
`call_count`, but its token total is null. Older ACP and CLI transcript writers
used zero placeholders; when the record cannot establish a measured zero, the
report treats those placeholders as unknown. Rebuilding the usage cache cannot
recover token counts that were never recorded.
This is an activity metric, not an invoice reconciliation API.

The initial scope is owned personal agents, including historical activity of
disabled users while their identity remains available. It excludes shared room
agents and independent AI programs running on a VM or elsewhere. Those programs
need their own usage source. Do not attribute all shared room usage to the room
owner. If a personal record cannot be mapped to a verified `knox_id`, exclude it
from employee rows, set `data_status=partial`, and include
`UNATTRIBUTED_PERSONAL_USAGE` in warnings.

The current source is retained session records with a rebuildable SQLite usage
cache. It is not a durable billing ledger. Deleted records, discarded transcript
branches, and calls never persisted cannot be reconstructed from this source.
Always declare `coverage=retained_records` and include
`HISTORICAL_COVERAGE_UNVERIFIED`. `data_status=complete` means the requested
retained source was fully read and its cache was current, not that every
historical provider call is accounted for. A durable event ledger is required
before claiming full historical coverage.

Return `data_status=partial` for missing identity, incomplete source reads,
unknown token totals, or stale caches in the selected scope; identify the reason
in warnings. Do not mark one person's report partial merely because an unrelated
person's source is unavailable. If no
reliable snapshot is available, return `503`, never a successful all-zero report.
The current month remains provisional even when retained-source collection is
complete. Closed months may change after corrections or record deletion.

## Response metadata

Return one JSON object containing `raw_data` and `meta`, with
`Content-Type: application/json` and `Cache-Control: no-store`.

| Field under `meta`  | Type            | Meaning                                                                                                                                                                        |
| ------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema_version`    | string          | `1`, the initial report contract.                                                                                                                                              |
| `source`            | string          | `platformclaw`, the collector source identifier.                                                                                                                               |
| `fetched_at`        | number          | Report assembly time as Unix seconds; fractional seconds allowed. Not a completeness watermark.                                                                                |
| `row_count`         | integer         | Exact length of `raw_data`.                                                                                                                                                    |
| `active_row_count`  | integer         | Rows where `call_count > 0` or known `token_usage > 0`.                                                                                                                        |
| `team_size`         | integer or null | Registered users matching identity and department filters, including disabled users, before usage/provider/model filters; null if roster unavailable. Not corporate headcount. |
| `active_user_count` | integer         | Distinct active `knox_id` values in the full filtered result before `limit`.                                                                                                   |
| `months`            | string array    | All requested months in ascending order, including empty months.                                                                                                               |
| `total_tokens`      | integer or null | Token sum across the full filtered result before `limit`; null if any contributing row is null.                                                                                |
| `returned_tokens`   | integer or null | Token sum across returned rows; zero for a verified empty result, null if any returned row is null.                                                                            |
| `total_call_count`  | integer         | Call sum across the full filtered result before `limit`.                                                                                                                       |
| `total_row_count`   | integer         | Matching report rows before `limit`.                                                                                                                                           |
| `truncated`         | boolean         | True when an explicit top-result limit omitted matching rows.                                                                                                                  |
| `filters`           | object          | Effective `knox_id` array (sorted; empty means all), and nullable `team`, `provider`, `model` strings; null means no filter.                                                   |
| `sort`              | string          | Effective sort field.                                                                                                                                                          |
| `order`             | string          | Effective sort direction.                                                                                                                                                      |
| `limit`             | integer or null | Explicit top-result limit, or null for a full report.                                                                                                                          |
| `timezone`          | string          | `Asia/Seoul`.                                                                                                                                                                  |
| `group_by`          | string          | Effective `service` or `model` grouping.                                                                                                                                       |
| `scope`             | string          | `personal_agents`.                                                                                                                                                             |
| `call_count_basis`  | string          | `usage_records`.                                                                                                                                                               |
| `token_usage_basis` | string          | `provider_total_or_components`.                                                                                                                                                |
| `coverage`          | string          | `retained_records`.                                                                                                                                                            |
| `data_status`       | string          | `complete` or `partial` for the retained source.                                                                                                                               |
| `warnings`          | string array    | Unique reason codes; always includes `HISTORICAL_COVERAGE_UNVERIFIED`.                                                                                                         |

Warning codes are `HISTORICAL_COVERAGE_UNVERIFIED`, `DIRECTORY_SIZE_UNAVAILABLE`,
`UNKNOWN_TEAM`, `UNKNOWN_MODEL`, `UNKNOWN_TOKEN_USAGE`,
`UNATTRIBUTED_PERSONAL_USAGE`, `SOURCE_READ_INCOMPLETE`, and `USAGE_CACHE_STALE`.
The first four codes alone do not make retained-source collection partial.
An unknown model still belongs in its own model bucket. Additive warning codes
may appear; collectors must tolerate them.

## Example model response

The employee, department, provider, model IDs, and numbers below are fictional.

```json
{
  "raw_data": [
    {
      "team": "Example Engineering",
      "month": "2026-10",
      "knox_id": "person.one",
      "ai_service": "PlatformClaw",
      "call_count": 120,
      "token_usage": 300000,
      "provider": "example-provider",
      "model": "example-model-a"
    },
    {
      "team": "Example Engineering",
      "month": "2026-10",
      "knox_id": "person.one",
      "ai_service": "PlatformClaw",
      "call_count": 80,
      "token_usage": 200000,
      "provider": "example-provider",
      "model": "example-model-b"
    }
  ],
  "meta": {
    "schema_version": "1",
    "source": "platformclaw",
    "fetched_at": 1793574000,
    "row_count": 2,
    "active_row_count": 2,
    "team_size": 10,
    "active_user_count": 1,
    "months": ["2026-10"],
    "total_tokens": 500000,
    "returned_tokens": 500000,
    "total_call_count": 200,
    "total_row_count": 2,
    "truncated": false,
    "filters": { "knox_id": [], "team": null, "provider": null, "model": null },
    "sort": "month",
    "order": "asc",
    "limit": null,
    "timezone": "Asia/Seoul",
    "group_by": "model",
    "scope": "personal_agents",
    "call_count_basis": "usage_records",
    "token_usage_basis": "provider_total_or_components",
    "coverage": "retained_records",
    "data_status": "complete",
    "warnings": ["HISTORICAL_COVERAGE_UNVERIFIED"]
  }
}
```

For `group_by=service`, the same snapshot yields one row with `call_count=200`,
`token_usage=500000`, and null `provider`/`model`. `row_count` and
`active_row_count` and `total_row_count` become 1; `active_user_count` stays 1.

## CSV download

`format=csv` applies the same date selection, filters, grouping, sorting, and
optional limit. Return UTF-8 with a BOM for Excel, comma-separated values,
CRLF row endings, and this fixed header order:

```csv
team,month,knox_id,ai_service,call_count,token_usage,provider,model
```

Quote fields containing commas, double quotes, or line breaks; escape embedded
double quotes by doubling them. Null is an empty cell. Numeric counts are plain
decimal numbers without grouping separators. Prefix textual values beginning
with `=`, `+`, `-`, `@`, tab, carriage return, or line feed with an apostrophe
to prevent spreadsheet formula execution. JSON preserves original text and is
the canonical machine ingestion format.

Return `Content-Type: text/csv; charset=utf-8`, `Cache-Control: no-store`, and
`Content-Disposition: attachment; filename="ai-usage-2026-10_2026-10-service.csv"`,
using the resolved months and grouping. Include `X-Report-Data-Status`,
`X-Report-Truncated`, `X-Report-Total-Rows`, and `X-Report-Total-Tokens` headers.
The last header is `unknown` when the full token total is unknown. CSV is
available only for complete retained-source reports; partial or unavailable
data returns `503` with a JSON error so a spreadsheet download cannot silently
hide missing data. Historical retention limitations still apply. A verified
empty result downloads the header row only. An explicit `limit` may produce an
intentional truncated ranking, identified by its response header.

## Errors

| Status | Error code              | Collector action                                                                                                              |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `400`  | `INVALID_REQUEST`       | Correct conflicting dates, invalid/duplicate/unknown parameters, blank filters, or oversized ranges; remove the request body. |
| `404`  | `USER_NOT_FOUND`        | Correct accounts listed in `error.details.unknown_knox_ids`.                                                                  |
| `403`  | `NETWORK_ACCESS_DENIED` | Ask the operator to check the approved network route.                                                                         |
| `405`  | `METHOD_NOT_ALLOWED`    | Use `GET`; the application returns `Allow: GET`.                                                                              |
| `413`  | `REPORT_TOO_LARGE`      | Retry with a smaller month range.                                                                                             |
| `429`  | `RATE_LIMITED`          | Retry after the integer seconds in `Retry-After`.                                                                             |
| `503`  | `REPORT_UNAVAILABLE`    | Retry after the integer seconds in `Retry-After`; preserve the last accepted report.                                          |
| `500`  | `INTERNAL_ERROR`        | Preserve the last accepted report and contact the operator.                                                                   |

Application errors use the following envelope and `Cache-Control: no-store`:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "start_month and end_month must use YYYY-MM format"
  }
}
```

For unknown accounts, `error.details` contains
`{"unknown_knox_ids": ["missing.person"]}` with unique normalized account IDs.
Other errors omit `details`. Both report and directory endpoints use this
envelope; directory unavailability also uses `REPORT_UNAVAILABLE`.

A firewall or reverse proxy can deny a connection without the JSON envelope.
Collectors must handle connection failures and non-JSON errors. Responses never
redirect to login or contain chat text, prompts, credentials, or host paths.

## Deploy and connect a collector

The Runtime Compose publishes the Control Plane on port `19002` by default
(`PLATFORMCLAW_PUBLIC_PORT` selects another existing host port). The application
uses its existing listener; do not publish the private Gateway port. After
deploying a build containing this API, allow the collector's source IP or the
approved corporate subnet to reach the existing Web port, or route these paths
through the existing HTTPS reverse proxy.

For direct intranet access on the default Compose port:

```bash
curl --fail-with-body \
  'http://platformclaw.example.com:19002/platformclaw/api/v1/reports/ai-usage?knox_id=person.one'
```

Replace the example host and account with the deployed server and a registered
account. HTTP `200` returns the current month's report. `404 USER_NOT_FOUND`
means the route is available but the selected account does not exist. `503`
with `Retry-After` means the source is temporarily unavailable or warming its
usage cache; preserve the last accepted report and retry after the stated delay.
Use the account-search endpoint to discover a registered login. No login page,
API key, `Authorization` header, or session cookie is involved.

## Ownership and network boundary

The user-facing decision is intranet access without application authentication.
The operator chooses the approved corporate subnet or collector IP list at the
network edge; no new account or token issuance is required. Every allowed client
can read the same configured reporting scope. Per-user authorization is not
claimed. Do not expose this unauthenticated route to the public internet.

Apply any IP rule to the actual socket peer or at a trusted reverse proxy.
Never accept an arbitrary `X-Forwarded-For` value as network authorization. If
the proxy is the network boundary, prevent clients from bypassing it to reach
the origin listener. Existing browser and Gateway authorization remains in
effect for all other routes.

The Control Plane owns HTTP reporting and directory joins. Reuse the existing
Gateway usage surface internally; no collector-facing generic Gateway RPC is
needed. Integration points are `src/gateway/server-methods/usage.ts`,
`src/infra/session-cost-usage-rollup.ts`, and the personal-agent and employee
contracts in `packages/platformclaw-control-plane/src/contracts.ts`.

Model grouping preserves unknown-model usage, and missing token counts remain
unknown instead of becoming a measured zero. Employee IDs are never substituted
by this reporting layer for the canonical directory account ID. There is no
global data watermark inferred from the latest individual cache scan.

Before enabling the endpoint, exercise allowed and denied intranet connections,
service/model conservation including unknown buckets, Korean month boundaries,
empty reports, partial source reads, account/department changes, oversized
responses, personal and multi-account filters, name lookup, date-selector
conflicts, ranking totals, filtered collector replacement, CSV escaping and
formula protection, and the error envelopes. Publish the actual intranet origin and
network rules in operator configuration. Firewall rules and live deployments
remain operator-owned; this API does not change them automatically.

## Related contracts

- [Employee authentication](/platformclaw/employee-auth)
- [Web ingress runtime](/platformclaw/web-ingress-runtime)
