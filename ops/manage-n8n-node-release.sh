#!/bin/sh

set -eu

PACKAGE_NAME="n8n-nodes-wechat-offiaccount"
CONTAINER="${CONTAINER:-z8n}"
VOLUME="${VOLUME:-n8n}"
STATE_DIR="${STATE_DIR:-/opt/z8n/wechat-node-maintenance}"

usage() {
	printf '%s\n' \
		"Usage:" \
		"  $0 install <https-url-or-absolute-tgz> <sha256> <expected-version> [extra-package@version ...]" \
		"  $0 verify <expected-version>" \
		"  $0 list-backups" \
		"  $0 rollback <backup-id>"
}

fail() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

require_command() {
	command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

container_image() {
	docker inspect "$CONTAINER" --format '{{.Config.Image}}'
}

installed_version() {
	docker run --rm --user node \
		-v "$VOLUME:/home/node/.n8n" \
		--entrypoint node "$IMAGE" \
		-p "require('/home/node/.n8n/nodes/node_modules/$PACKAGE_NAME/package.json').version"
}

wait_until_running() {
	attempt=0
	while [ "$attempt" -lt 30 ]; do
		if [ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" = "true" ]; then
			sleep 2
			[ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" = "true" ] && return 0
		fi
		attempt=$((attempt + 1))
		sleep 1
	done
	return 1
}

verify_installation() {
	expected="$1"
	actual="$(installed_version)"
	[ "$actual" = "$expected" ] || fail "expected $expected, found $actual"

	docker run --rm --user node \
		-v "$VOLUME:/home/node/.n8n" \
		--entrypoint node "$IMAGE" \
		-e "const fs=require('fs'); const base='/home/node/.n8n/nodes/node_modules/$PACKAGE_NAME'; require(base+'/dist/credentials/WechatOfficialAccountCredentialsApi.credentials.js'); require(base+'/dist/nodes/WechatOfficialAccountNode/WechatOfficialAccountNode.node.js'); const s=fs.readFileSync(base+'/dist/credentials/WechatOfficialAccountCredentialsApi.credentials.js','utf8'); if(!s.includes('/cgi-bin/stable_token')) throw new Error('stable token endpoint missing'); if(s.includes('preAuthentication credentials')) throw new Error('credential logging still present');"
	started_at="$(docker inspect "$CONTAINER" --format '{{.State.StartedAt}}')"
	if docker logs --since "$started_at" "$CONTAINER" 2>&1 | grep -Eqi 'failed to load package|error loading package|cannot find module'; then
		fail "n8n logs contain a package load error"
	fi
	printf 'verified %s@%s in %s\n' "$PACKAGE_NAME" "$actual" "$CONTAINER"
}

verify_restored_version() {
	expected="$1"
	actual="$(installed_version)"
	[ "$actual" = "$expected" ] || fail "rollback expected $expected, found $actual"
	printf 'restored %s@%s in %s\n' "$PACKAGE_NAME" "$actual" "$CONTAINER"
}

create_backup() {
	previous_version="$(installed_version)"
	backup_id="$(date -u +%Y%m%dT%H%M%SZ)-${previous_version}"
	backup_dir="$STATE_DIR/backups/$backup_id"
	mkdir -p "$backup_dir"

	docker run --rm --user 0 \
		-v "$VOLUME:/data:ro" \
		-v "$backup_dir:/backup" \
		--entrypoint sh "$IMAGE" \
		-c 'test -d /data/nodes && tar -czf /backup/nodes.tgz -C /data nodes'

	printf 'backup_id=%s\nprevious_version=%s\ncreated_utc=%s\n' \
		"$backup_id" "$previous_version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		> "$backup_dir/metadata.txt"
	printf '%s\n' "$backup_id" > "$STATE_DIR/last-backup"
	printf '%s\n' "$backup_id"
}

restore_backup_files() {
	backup_id="$1"
	backup_dir="$STATE_DIR/backups/$backup_id"
	[ -f "$backup_dir/nodes.tgz" ] || fail "backup not found: $backup_id"
	failed_id="$(date -u +%Y%m%dT%H%M%SZ)"

	docker run --rm --user 0 \
		-v "$VOLUME:/data" \
		-v "$backup_dir:/backup:ro" \
		--entrypoint sh "$IMAGE" \
		-c 'mkdir -p /data/node-failed; if [ -d /data/nodes ]; then mv /data/nodes "/data/node-failed/nodes-'"$failed_id"'"; fi; tar -xzf /backup/nodes.tgz -C /data'
}

install_release() {
	source="$1"
	expected_sha="$2"
	expected_version="$3"
	shift 3

	case "$expected_sha" in
		*[!0-9a-fA-F]*|'') fail "SHA-256 must contain only hexadecimal characters" ;;
	esac
	[ "${#expected_sha}" -eq 64 ] || fail "SHA-256 must be 64 characters"
	case "$expected_version" in
		*[!0-9A-Za-z.-]*|'') fail "invalid version" ;;
	esac
	for package_spec in "$@"; do
		case "$package_spec" in
			*[!0-9A-Za-z@/._-]*|'') fail "invalid extra package spec: $package_spec" ;;
		esac
	done

	mkdir -p "$STATE_DIR/releases" "$STATE_DIR/backups"
	artifact_name="$(basename "$source")"
	case "$artifact_name" in
		*[!0-9A-Za-z._-]*|'') fail "invalid artifact filename" ;;
	esac
	artifact="$STATE_DIR/releases/$artifact_name"

	case "$source" in
		https://*)
			curl --fail --location --proto '=https' --tlsv1.2 "$source" --output "$artifact"
			;;
		/*)
			[ -f "$source" ] || fail "artifact not found: $source"
			if [ "$source" != "$artifact" ]; then
				cp "$source" "$artifact"
			fi
			;;
		*) fail "artifact source must be an HTTPS URL or absolute path" ;;
	esac

	actual_sha="$(sha256sum "$artifact" | awk '{print $1}')"
	[ "$actual_sha" = "$expected_sha" ] || fail "artifact checksum mismatch"

	package_version="$(docker run --rm --user 0 -v "$artifact:/release.tgz:ro" --entrypoint sh "$IMAGE" -c 'tar -xOzf /release.tgz package/package.json | node -e '\''let s=""; process.stdin.on("data", c => s += c); process.stdin.on("end", () => { const p=JSON.parse(s); process.stdout.write(p.name+" "+p.version); });'\''')"
	[ "$package_version" = "$PACKAGE_NAME $expected_version" ] || fail "artifact identity mismatch: $package_version"

	backup_id="$(create_backup)"
	printf 'created backup %s\n' "$backup_id"

	docker run --rm --user 0 \
		-v "$VOLUME:/home/node/.n8n" \
		-v "$artifact:/source.tgz:ro" \
		--entrypoint sh "$IMAGE" \
		-c 'mkdir -p /home/node/.n8n/node-releases; cp /source.tgz "/home/node/.n8n/node-releases/'"$artifact_name"'"; chown -R node:node /home/node/.n8n/node-releases'

	docker stop "$CONTAINER" >/dev/null
	if ! docker run --rm --user node \
		-v "$VOLUME:/home/node/.n8n" \
		--workdir /home/node/.n8n/nodes \
		--entrypoint npm "$IMAGE" \
		install --save-exact "/home/node/.n8n/node-releases/$artifact_name" "$@"; then
		printf 'installation failed; restoring %s\n' "$backup_id" >&2
		restore_backup_files "$backup_id"
		docker start "$CONTAINER" >/dev/null
		fail "installation failed and the previous node directory was restored"
	fi

	docker start "$CONTAINER" >/dev/null
	if ! wait_until_running || ! verify_installation "$expected_version"; then
		printf 'verification failed; restoring %s\n' "$backup_id" >&2
		docker stop "$CONTAINER" >/dev/null 2>&1 || true
		restore_backup_files "$backup_id"
		docker start "$CONTAINER" >/dev/null
		wait_until_running || true
		fail "verification failed and the previous node directory was restored"
	fi

	printf 'installed_version=%s\nartifact=%s\nsha256=%s\nbackup_id=%s\ninstalled_utc=%s\n' \
		"$expected_version" "$artifact_name" "$actual_sha" "$backup_id" \
		"$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$STATE_DIR/current-release.txt"
	printf 'installation complete; rollback id: %s\n' "$backup_id"
}

rollback_release() {
	backup_id="$1"
	backup_dir="$STATE_DIR/backups/$backup_id"
	[ -f "$backup_dir/metadata.txt" ] || fail "backup metadata not found: $backup_id"
	expected="$(awk -F= '$1 == "previous_version" { print $2 }' "$backup_dir/metadata.txt")"
	[ -n "$expected" ] || fail "backup has no previous_version"

	docker stop "$CONTAINER" >/dev/null
	restore_backup_files "$backup_id"
	docker start "$CONTAINER" >/dev/null
	wait_until_running || fail "container did not remain running after rollback"
	verify_restored_version "$expected"
	printf 'rollback complete: %s\n' "$backup_id"
}

require_command docker
require_command sha256sum
[ "$(docker inspect "$CONTAINER" --format '{{.State.Running}}' 2>/dev/null || true)" = "true" ] || fail "container is not running: $CONTAINER"
IMAGE="${IMAGE:-$(container_image)}"
docker volume inspect "$VOLUME" >/dev/null 2>&1 || fail "Docker volume not found: $VOLUME"

command="${1:-}"
case "$command" in
	install)
		[ "$#" -ge 4 ] || { usage; exit 2; }
		require_command curl
		shift
		install_release "$@"
		;;
	verify)
		[ "$#" -eq 2 ] || { usage; exit 2; }
		verify_installation "$2"
		;;
	list-backups)
		[ "$#" -eq 1 ] || { usage; exit 2; }
		if [ -d "$STATE_DIR/backups" ]; then
			find "$STATE_DIR/backups" -mindepth 1 -maxdepth 1 -type d -exec basename {} \; | sort
		fi
		;;
	rollback)
		[ "$#" -eq 2 ] || { usage; exit 2; }
		rollback_release "$2"
		;;
	*)
		usage
		exit 2
		;;
esac
