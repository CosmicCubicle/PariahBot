#!/usr/bin/env bash
set -euo pipefail

# Installs PariahBot as a Docker container: the published image, run by
# compose.yaml from /opt/pariahbot-container. deploy/setup.sh is the systemd
# alternative; both ask the same questions (deploy/configure.sh). Idempotent:
# rerunning keeps hom.env's values unless replaced, and pulls the newest image.

if [ "${EUID}" -ne 0 ]; then
	printf 'Run with sudo: sudo ./deploy/container-setup.sh\n' >&2
	exit 1
fi

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INSTALL_DIR=/opt/pariahbot-container
# Owns hom.env, and is the account named in the SSH tunnel hint. The bot itself
# runs as the image's own unprivileged user, whoever this is.
BOT_USER=${SUDO_USER:-root}
CONFIG_FILE="$INSTALL_DIR/hom.env"
UPDATE_FILE=/usr/local/sbin/pariahbot-container-update
CRON_FILE=/etc/cron.d/pariahbot-container
SYSTEMD_DIR=/opt/PariahBot

. "$SOURCE_DIR/deploy/configure.sh"

# Docker Engine and the Compose plugin. Installed from Ubuntu's own packages
# when they're missing; anywhere else, Docker's instructions cover it.
if ! docker compose version >/dev/null 2>&1; then
	if command -v apt-get >/dev/null && apt-cache show docker-compose-v2 >/dev/null 2>&1; then
		ask_yes_no "Docker isn't installed. Install it from your distribution's packages?" || exit 1
		apt-get update
		DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io docker-compose-v2
		systemctl enable --now docker
	else
		printf 'Install Docker Engine and the Compose plugin first: https://docs.docker.com/engine/install/\n' >&2
		exit 1
	fi
fi

mkdir -p "$INSTALL_DIR"
# Replaced on every run, so rerunning picks up a newer compose.yaml. hom.env
# and any .env (PARIAHBOT_IMAGE) are never overwritten.
cp "$SOURCE_DIR/compose.yaml" "$SOURCE_DIR/.env.example" "$INSTALL_DIR"/
cd "$INSTALL_DIR"

configure_bot_env "$INSTALL_DIR/.env.example"

# A systemd install of the same bot (deploy/setup.sh) would log in alongside
# the container, and both would answer every command and run moderation,
# alerts and pollers. Offer to retire it; another bot's install is left alone.
REPLACING_SYSTEMD=no
if [ -f "$SYSTEMD_DIR/hom.env" ] && [ "$(get_value DISCORD_TOKEN "$SYSTEMD_DIR/hom.env")" = "$TOKEN" ] \
	&& systemctl is-enabled pariahbot.service >/dev/null 2>&1; then
	printf '\nThis bot is also installed under systemd (%s).\n' "$SYSTEMD_DIR"
	if ! ask_yes_no 'Stop and disable it, so only the container runs? Its files are kept'; then
		printf 'Not starting the container while the systemd install is enabled.\n' >&2
		exit 1
	fi
	systemctl disable --now pariahbot.service
	# Its auto-update job would restart the service on the next push to main.
	SERVICE_USER=$(awk -F= '$1 == "User" { print $2 }' /etc/systemd/system/pariahbot.service 2>/dev/null || true)
	rm -f /usr/local/sbin/pariahbot-sync /etc/sudoers.d/pariahbot-sync
	if [ -n "$SERVICE_USER" ] && crontab -u "$SERVICE_USER" -l >/dev/null 2>&1; then
		crontab -u "$SERVICE_USER" -l | grep -vF /usr/local/sbin/pariahbot-sync | crontab -u "$SERVICE_USER" -
	fi
	REPLACING_SYSTEMD=yes
fi

# A pull that fails still leaves an image already here to start from; with
# none, `up` below reports the failure.
docker compose pull --ignore-pull-failures

# Bring over the systemd install's database, but never over one the container
# already has. Copied as root because the old files belong to that install's
# user, then handed to the image's.
if [ "$REPLACING_SYSTEMD" = yes ] && [ -f "$SYSTEMD_DIR/data/pariahbot.sqlite" ] \
	&& docker compose run --rm --no-deps --entrypoint sh pariahbot -c 'test ! -e data/pariahbot.sqlite' \
	&& ask_yes_no "Copy its database ($SYSTEMD_DIR/data) into the container?"; then
	docker compose run --rm --no-deps --user root -v "$SYSTEMD_DIR/data:/import:ro" --entrypoint sh pariahbot \
		-c 'cp /import/pariahbot.sqlite* data/ && chown node:node data/*'
	printf 'Database copied. The original stays in %s/data.\n' "$SYSTEMD_DIR"
fi

# Optionally check for a newer image every 15 minutes, the container
# counterpart of deploy/setup.sh's git sync job.
if ask_yes_no 'Install the update job (pulls a newer image every 15 minutes)?'; then
	cat > "$UPDATE_FILE" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# Pull the PariahBot image and recreate the container only when it changed.
# Installed by deploy/container-setup.sh. Logs to $INSTALL_DIR/update.log.
cd $INSTALL_DIR
# Compose reports progress on stderr even when quiet, which would add lines to
# the log every 15 minutes; its output is kept only when a step fails.
run() {
	local out
	out=\$("\$@" 2>&1) || { echo "\$(date -Is) \$* failed:"; echo "\$out"; exit 1; }
}
BEFORE=\$(docker compose images -q pariahbot 2>/dev/null || true)
run docker compose pull --quiet
run docker compose up -d
AFTER=\$(docker compose images -q pariahbot 2>/dev/null || true)
[ "\$BEFORE" = "\$AFTER" ] && exit 0
echo "\$(date -Is) updated to image \$AFTER, container recreated"
docker image prune -f >/dev/null
EOF
	chmod 755 "$UPDATE_FILE"
	cat > "$CRON_FILE" <<EOF
# Installed by PariahBot's deploy/container-setup.sh.
0,15,30,45 * * * * root $UPDATE_FILE >> $INSTALL_DIR/update.log 2>&1
EOF
	chmod 644 "$CRON_FILE"
else
	rm -f "$UPDATE_FILE" "$CRON_FILE"
fi

# Starting the container registers the slash commands (see the Dockerfile).
docker compose up -d
printf '\nPariahBot is running in the "pariahbot" container. Configuration is in %s.\n' "$CONFIG_FILE"
printf 'Logs: sudo docker logs -f pariahbot\n'
print_dashboard_steps
