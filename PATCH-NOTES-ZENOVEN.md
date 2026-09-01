# ZenOven Stable Access Token maintenance release

Base: upstream commit `bb50792b888d1fa2a240357ff79b607f9bfb2bb3` (`0.3.6`).
Maintained package version: `0.3.6-zenoven.1`.

## What changed

- Replaces `GET /cgi-bin/token` with `POST /cgi-bin/stable_token`.
- Uses `force_refresh=false` for normal token acquisition.
- On WeChat business errors `40001`, `40014`, or `42001`, requests one forced refresh and retries
  the original request once.
- Rebuilds multipart upload bodies for the retry instead of reusing a consumed stream.
- Returns the second WeChat error without a third attempt.
- Does not retry node-level network failures. This avoids blindly replaying material uploads or
  draft creation after an unknown outcome.
- Serializes concurrent token refreshes in one n8n process and reuses a forced token for 30 seconds.
- Removes credential and token response logging and masks AppSecret in the credential UI.
- Moves runtime imports (`glob` and `form-data`) into production dependencies and updates them to
  maintained releases.
- Uses n8n's current HTTP request helper and public type exports.

## Supported installation path

Use the exact `.tgz` asset and `SHA256SUMS` file attached to the matching GitHub Release. Install
the artifact in the persistent n8n community-node directory, then restart n8n:

```sh
cd /home/node/.n8n/nodes
npm install --save-exact /persistent/path/n8n-nodes-wechat-offiaccount-0.3.6-zenoven.1.tgz
```

Keep the release artifact in persistent storage. The production helper script creates a backup of
the existing package and npm manifests before changing the installation. Do not edit files under
`node_modules` directly and do not use the Community Nodes **Update** action for this fork.

For the current Docker deployment, use [`ops/manage-n8n-node-release.sh`](ops/manage-n8n-node-release.sh).
It backs up the complete community-node directory, verifies the release checksum and package
identity, stops only the n8n container during the package change, checks startup logs for any
community-package load failure, and retains the previous installation for an explicit rollback.
Optional exact package specs may follow the maintained version argument when the shared community
directory has known runtime supplements that npm must retain as declared root dependencies.

## Verification

- `pnpm test`: token request, concurrency, bounded retry, multipart-body rebuild, and error mapping.
- `pnpm lint`: source and package lint.
- `git diff --check`: whitespace validation.
- Packaged artifact installation in an isolated container using the production n8n version.
- Node-type load check for the main node, trigger, response node, tool variant, and credential type.

No real WeChat credential, material upload, draft creation, or production workflow execution is
used by the automated tests.

## Production gates

- Rotate the previously exposed AppSecret before using the maintained package for production calls.
- Back up the current community-node directory and n8n database/config before replacement.
- Install the release artifact in the existing n8n volume and restart only the n8n service.
- Verify a read-only credential/status request first.
- Obtain explicit approval before uploading test material or creating a test draft.
- Verify workflow output fields, the expected Google Sheets row, and the rollback path.

## Scope limitation

Refresh coordination is process-local. It is suitable for the current single n8n process, but not
a distributed lock for queue mode or multiple replicas. A separate gateway remains the stronger
long-term boundary for multiple accounts, cross-workflow policy, audit logging, durable idempotency,
and multi-process concurrency.
