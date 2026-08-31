# ZenOven fork maintenance

This repository is a maintained fork of
[`other-blowsnow/n8n-nodes-wechat-offiaccount`](https://github.com/other-blowsnow/n8n-nodes-wechat-offiaccount).
It keeps the upstream npm package name and n8n type identifiers so existing workflows can load the
maintained artifact without node migration.

## Version policy

- Use `<upstream-version>-zenoven.<revision>` for maintained releases.
- Increase `<revision>` for another release based on the same upstream version.
- When adopting a newer upstream release, use its version and restart the suffix at `zenoven.1`.
- GitHub Releases are the distribution channel. Do not publish this fork over the upstream npm
  package name.

For example, `0.3.6-zenoven.1` is the first maintained release based on upstream `0.3.6`; it is not
an upstream npm release.

## Sync upstream safely

Never replace the maintained branch with upstream or merge upstream directly into production.
Prepare a review branch instead:

```sh
git fetch origin upstream --tags
git switch -c codex/sync-upstream-YYYYMMDD origin/master
git merge --no-ff upstream/master
```

During conflict review, preserve these fork guarantees unless the upstream implementation has been
verified to supersede them:

- Stable Access Token uses `POST /cgi-bin/stable_token` and `force_refresh=false` normally.
- Only WeChat errors `40001`, `40014`, and `42001` trigger one forced refresh and one replay.
- Unknown network outcomes do not replay write operations.
- Multipart bodies are rebuilt before a replay.
- Credentials and token responses are never logged; AppSecret remains masked.
- Runtime imports stay in `dependencies`, not `devDependencies`.
- The existing credential type and all n8n node type identifiers remain unchanged.

Review the complete upstream delta, not only files that conflict:

```sh
git diff --stat origin/master...HEAD
git diff origin/master...HEAD
```

## Validate a candidate

Use the pinned pnpm version from `packageManager`, then run:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm lint
sh -n ops/manage-n8n-node-release.sh
npm pack --dry-run
git diff --check
```

Also install the packed artifact in an isolated container using the same n8n version as production.
Prove both upgrade from the currently deployed package and restoration of the complete backed-up
community-node directory. Automated validation must not use a real AppSecret or write to WeChat.

## Release

1. Update `package.json`, `pnpm-lock.yaml`, and the release notes to the next maintained version.
2. Open a pull request and require the CI workflow to pass.
3. Merge the pull request into `master`.
4. Create an annotated tag named exactly `v<package-version>` on the merged commit and push it.
5. Confirm the Release workflow passes and publishes both the `.tgz` and `SHA256SUMS` assets.
6. Download the published assets and independently verify the checksum and package name/version.
7. Update the production operations record with the immutable release URL and SHA-256.

The tag-to-package-version check in the Release workflow prevents an incorrectly named release.

## Production promotion

Use a fixed GitHub Release artifact and checksum with `ops/manage-n8n-node-release.sh`. Do not install
from a branch, a mutable URL, npm `latest`, or n8n's Community Nodes **Update** action.

Before promotion, confirm the AppSecret has not been exposed and rotate it if necessary. The helper
must create a complete community-node backup before stopping only the n8n container. After startup,
verify package loading and a read-only credential request before obtaining separate approval for any
material upload, draft creation, or other WeChat write.

Record the release version, artifact SHA-256, installation time, backup ID, container restart state,
and read-only verification result. Keep the exact artifact and the backup ID required for rollback.

## Returning to upstream

If upstream publishes an equivalent fix, do not switch merely because its version is newer. Compare
the implementation against every fork guarantee above, test the upstream package in isolation, and
prove upgrade and rollback using the production n8n version. Only then replace the pinned fork
artifact and update the operations record.
