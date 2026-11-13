# BellBeast API v1

Read-only access to plant data published by BellBeast. Each **dataset** is a named set of fields
(for example `flow`, `pressure`) sampled every 60 seconds. The machine-readable description is at
`GET /api/v1/openapi.json`; it lists only the datasets your key can read.

## Getting access

Ask the BellBeast administrator for an API key. The administrator creates it in
*Admin → API Access → API Clients* and grants the datasets you need. The key looks like
`bbk_…`, is shown once, and can be rotated or disabled at any time.

Send it on every request, either way:

```
X-Api-Key: bbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Authorization: Bearer bbk_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Each key has its own request limit per minute (default 120).

## Endpoints

### List datasets you can read

```
GET /api/v1/datasets
```

```json
{
  "ok": true,
  "datasets": [
    {
      "id": "treated-water",
      "title": "Treated water (TPS)",
      "version": 1,
      "max_history": 120,
      "fields": [ { "name": "flow", "unit": "m3/h", "label": null }, { "name": "pressure", "unit": "bar", "label": null } ],
      "links": { "latest": "/api/v1/datasets/treated-water", "history": "/api/v1/datasets/treated-water/history?n=60" }
    }
  ]
}
```

### Latest values

```
GET /api/v1/datasets/{id}
GET /api/v1/datasets/{id}?fields=flow,pressure
```

```json
{
  "ok": true,
  "dataset": "treated-water",
  "version": 1,
  "fetched_at": "2026-11-13T04:30:28.61+00:00",
  "values": {
    "flow":     { "value": 45570, "ts": "2026-11-05T13:16:22+07:00", "unit": "m3/h" },
    "pressure": { "value": 20.63, "ts": "2026-11-05T13:16:22+07:00", "unit": "bar" }
  }
}
```

`ts` is when the plant measured the value (ISO 8601 with the plant's UTC offset); `value` is `null` when there is no reading.
Latest values are cached for up to 15 seconds.

### History

```
GET /api/v1/datasets/{id}/history?n=60
GET /api/v1/datasets/{id}/history?n=60&fields=flow
```

```json
{
  "ok": true,
  "dataset": "treated-water",
  "version": 1,
  "interval_sec": 60,
  "n": 60,
  "series": {
    "flow": [ { "ts": "2026-11-05T12:17:22+07:00", "value": 45210 }, "…" ]
  }
}
```

Points are oldest first. `n` is capped by the dataset's `max_history`; the response says which `n` was used.

## Versions

`version` goes up whenever the administrator changes a dataset's field list. Field names you already use
keep their meaning; check `version` (or `GET /api/v1/datasets`) if your integration depends on the exact set of fields.

## Errors

Errors are JSON: `{ "ok": false, "error": "<code>" }`.

| Status | `error` | Meaning |
|---|---|---|
| 400 | `unknown_field`, `bad_n` | `fields` names a field the dataset does not have, or `n` is not a positive number |
| 401 | `api_key_unknown`, `api_key_disabled`, `api_key_expired` | the key cannot be used (a request with no key at all gets a 401 with an empty body) |
| 403 | `dataset_not_granted` | your key is not allowed to read this dataset |
| 403 | `ip_banned` | your IP address is blocked |
| 404 | `unknown_dataset`, `api_disabled` | no such dataset, or the administrator has switched the API off |
| 429 | `rate_limited` | too many requests; wait `Retry-After` seconds |
| 502 | `upstream_unavailable` | the plant data service did not answer; retry later |

## Example

```bash
curl -s -H "X-Api-Key: $BELLBEAST_KEY" "https://<bellbeast-host>/api/v1/datasets/treated-water?fields=flow"
```
