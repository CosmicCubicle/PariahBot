#!/usr/bin/env bash
set -euo pipefail

if [ "${EUID}" -ne 0 ]; then
	printf 'Run with sudo: sudo ./deploy/install-host.sh\n' >&2
	exit 1
fi

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BOT_USER=${SUDO_USER:-}
if [ -z "$BOT_USER" ] || [ "$BOT_USER" = "root" ]; then
	printf 'Run this with sudo from the intended non-root user account.\n' >&2
	exit 1
fi

BOT_HOME=$(getent passwd "$BOT_USER" | cut -d: -f6)
INSTALL_DIR=/opt/PariahBot

for command in git curl ffmpeg; do
	if ! command -v "$command" >/dev/null 2>&1; then
		apt-get update
		apt-get install -y "$command"
	fi
done

if [ ! -d "$INSTALL_DIR/.git" ]; then
	mkdir -p "$INSTALL_DIR"
	cp -a "$REPO_DIR/." "$INSTALL_DIR/"
	chown -R "$BOT_USER:$BOT_USER" "$INSTALL_DIR"
else
	git -C "$INSTALL_DIR" pull --ff-only
fi

if [ ! -f "$INSTALL_DIR/hom.env" ]; then
	cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/hom.env"
	chown "$BOT_USER:$BOT_USER" "$INSTALL_DIR/hom.env"
	chmod 600 "$INSTALL_DIR/hom.env"
	printf 'Created %s; configure its secrets before starting the bot.\n' "$INSTALL_DIR/hom.env"
fi

sudo -u "$BOT_USER" HOME="$BOT_HOME" bash -lc '
	export NVM_DIR="$HOME/.nvm"
	if [ ! -s "$NVM_DIR/nvm.sh" ]; then
		curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
	fi
	. "$NVM_DIR/nvm.sh"
	nvm install 20
	nvm alias default 20
	cd /opt/PariahBot
	npm ci --omit=dev
'
sed "s/^User=cosmic$/User=$BOT_USER/" "$INSTALL_DIR/deploy/pariahbot.service" > /etc/systemd/system/pariahbot.service
chmod 644 /etc/systemd/system/pariahbot.service
chmod 755 "$INSTALL_DIR/deploy/sync-pariahbot.sh"
chmod 755 "$INSTALL_DIR/deploy/onboard.sh"

systemctl daemon-reload
systemctl enable pariahbot.service
(crontab -u "$BOT_USER" -l 2>/dev/null | grep -v 'sync-pariahbot.sh' || true; echo '0,15,30,45 * * * * /opt/PariahBot/deploy/sync-pariahbot.sh') | crontab -u "$BOT_USER" -

if ! grep -q '^DISCORD_TOKEN=your-bot-token-here$' "$INSTALL_DIR/hom.env"; then
	systemctl restart pariahbot.service
fi

printf 'Installation complete. Run the interactive onboarding prompt next:\n  %s/deploy/onboard.sh\n' "$INSTALL_DIR"