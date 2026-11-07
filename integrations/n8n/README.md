# AfterLink n8n workflows

n8n handles the outside-world edge of AfterLink: requests coming in, reports going out. It never coordinates the mission. Stop n8n and external intake and report publishing stop. Task decisions on the devices do not.

Two importable workflows, core nodes only, no credentials, no paid features (state is held in workflow static data):

| File | Purpose |
|---|---|
| `workflows/afterlink-intake.json` | Public request intake, validation, classification, delivery to the relay with retry, dead-letter store |
| `workflows/afterlink-debrief.json` | Receives the reconciled mission record, writes the after-action report, serves the latest report as a page |

## Import

1. In n8n, create a new workflow, paste the contents of a JSON file onto the canvas (Ctrl+V).
2. Open the **Config** node and set two values:
   - `relayUrl`: the public base URL of the relay (n8n must be able to reach it)
   - `secret`: the shared secret, identical to `N8N_INGRESS_SECRET` in the relay `.env`
3. Save and activate. Do this for both workflows, with the same two values.
4. Production webhook URLs, relative to your n8n base URL:
   - `POST /webhook/afterlink/intake`
   - `GET /webhook/afterlink/request` (a plain request form that posts to the intake)
   - `POST /webhook/afterlink/debrief`
   - `GET /webhook/afterlink/report` (latest after-action report)
5. In the relay `.env` set `N8N_WEBHOOK_URL` to the full debrief URL (`https://<your-n8n>/webhook/afterlink/debrief`) and `N8N_INGRESS_SECRET` to the same secret.

Webhooks only answer on their production URL while the workflow is active. Dead letters and the latest report persist only for active workflows.

## Intake flow

```
Webhook -> Config -> validate + stable source id -> POST /api/triage (6 s, optional)
        -> classify (triage result, else deterministic keyword rules)
        -> POST /ingress/request  (attempt 1)
             fail -> wait 2 s -> attempt 2 -> wait 4 s -> attempt 3 -> wait 8 s -> attempt 4
             ok   -> respond 200 with tracking state
             all failed -> dead-letter store -> respond 202 "held-for-retry"
Schedule (2 min) -> Config -> load dead letters -> POST /ingress/request -> drop delivered ones
```

- The source id is the supplied `sourceId`, or a hash of the normalised content. The relay creates at most one task per source id, so repeated deliveries, retries and dead-letter replays never duplicate a task.
- The relay answers `200 delivered` when a device received the request and `202 queued` when it holds the request until a device connects. Both count as accepted.
- Response body: `sourceId`, `state` (`delivered`, `queued-at-relay`, `held-for-retry`, `rejected`), `attempts`, `classification`, `detail`.
- Every run is visible in n8n Executions, with each attempt, wait and branch.

Example:

```
curl -X POST https://<your-n8n>/webhook/afterlink/intake \
  -H "content-type: application/json" \
  -d '{"title":"Wheelchair user stuck at north gate","locationName":"North gate"}'
```

## Debrief flow

The relay posts the reconciled `MissionRecord` (optionally wrapped as `{ "record": ..., "narrative": "..." }`) to the debrief webhook with the shared secret header. The workflow checks the secret, builds the report in Markdown and HTML, stores it, and answers with the report URL. Open `GET /webhook/afterlink/report` to read the latest one, with no sign-in. An email node is included but disabled; set a sender, recipient and your own SMTP credential, then enable it to also mail the report.

## Relay side

`apps/relay/src/ingress` mounts `POST /ingress/request` (header `x-afterlink-ingress-secret`) and `POST /report/debrief`. Tests: `npx vitest run apps/relay/test/ingress`.
