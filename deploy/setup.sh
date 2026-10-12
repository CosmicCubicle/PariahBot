#!/usr/bin/env bash
set -euo pipefail

# Setup must run as root so it can install packages and register system services.
if [ "${EUID}" -ne 0 ]; then
	printf 'Run with sudo: sudo ./deploy/setup.sh\n' >&2
	exit 1
fi

SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
INSTALL_DIR=/opt/PariahBot
BOT_USER=${SUDO_USER:-}
[ -n "$BOT_USER" ] && [ "$BOT_USER" != root ] || { printf 'Run with sudo from a non-root user.\n' >&2; exit 1; }
BOT_HOME=$(getent passwd "$BOT_USER" | cut -d: -f6)
CONFIG_FILE="$INSTALL_DIR/hom.env"
SERVICE_FILE=/etc/systemd/system/pariahbot.service
SYNC_FILE=/usr/local/sbin/pariahbot-sync

. "$SOURCE_DIR/deploy/configure.sh"

# Debian and Ubuntu only: the packages below come from apt-get. On AWS or
# Azure, pick an Ubuntu Server LTS image (see the wiki's hosting pages).
command -v apt-get >/dev/null || { printf 'This script needs a Debian or Ubuntu host (apt-get). On AWS or Azure, use an Ubuntu Server LTS image.\n' >&2; exit 1; }

# Two copies logged in with one token would both answer every command and both
# run moderation, alerts and pollers. Refuse if the container install (see
# deploy/container-setup.sh) is already running this bot.
CONTAINER_CONFIG=/opt/pariahbot-container/hom.env
if [ -f "$CONFIG_FILE" ] && [ -f "$CONTAINER_CONFIG" ] && command -v docker >/dev/null \
	&& [ -n "$(docker ps -q --filter name=^pariahbot$ 2>/dev/null)" ] \
	&& [ "$(get_value DISCORD_TOKEN "$CONTAINER_CONFIG")" = "$(get_value DISCORD_TOKEN)" ]; then
	printf 'This bot is already running in a container (/opt/pariahbot-container).\n' >&2
	printf 'Stop it first: cd /opt/pariahbot-container && sudo docker compose down\n' >&2
	exit 1
fi

# Install Git and what NVM needs to download Node. No compiler: better-sqlite3
# is pinned to a release with prebuilt binaries (see state/db.js), and nothing
# else the bot uses is native.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git

if [ "$SOURCE_DIR" != "$INSTALL_DIR" ]; then
	mkdir -p "$INSTALL_DIR"
	cp -a "$SOURCE_DIR"/. "$INSTALL_DIR"/
fi
chown -R "$BOT_USER:$BOT_USER" "$INSTALL_DIR"

# Install Node 24 with NVM and install the bot's production dependencies.
sudo -u "$BOT_USER" HOME="$BOT_HOME" bash -lc '
	export NVM_DIR="$HOME/.nvm"
	if [ ! -s "$NVM_DIR/nvm.sh" ]; then
		curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
	fi
	. "$NVM_DIR/nvm.sh"
	nvm install 24
	nvm alias default 24
	nvm use 24 >/dev/null
	cd /opt/PariahBot
	npm ci --omit=dev
'

# Ask for the Discord credentials and the dashboard settings, and write them
# to hom.env (see deploy/configure.sh, shared with the container setup).
configure_bot_env "$INSTALL_DIR/.env.example"

# Register the bot as a systemd service and enable it at boot.
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=PariahBot Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$BOT_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=/bin/bash -lc 'source "\$HOME/.nvm/nvm.sh" && nvm use 24 >/dev/null && exec node $INSTALL_DIR/index.js'
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "$SERVICE_FILE"
systemctl daemon-reload
systemctl enable pariahbot.service

# Optionally install a read-only Git polling job that refreshes commands before restarting the bot.
read -r -p 'Install the read-only Git sync cron job every 15 minutes? [y/N]: ' INSTALL_CRON
if [[ "$INSTALL_CRON" =~ ^[Yy]([Ee][Ss])?$ ]]; then
	cat > "$SYNC_FILE" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# Fetch origin/main, refresh dependencies and commands, then restart the service.
REPO_DIR=/opt/PariahBot
LOG="$REPO_DIR/sync.log"
BRANCH=main
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
nvm use 24 >/dev/null
cd "$REPO_DIR"
LOCAL=$(git rev-parse HEAD)
git fetch origin "$BRANCH" --quiet
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] && exit 0
echo "$(date -Is) syncing $LOCAL -> $REMOTE" >> "$LOG"
PKG_BEFORE=$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)
COMMANDS_CHANGED=$(git diff --name-only "$LOCAL" "$REMOTE" -- commands/ deploy-commands.js)
git reset --hard "origin/$BRANCH" >> "$LOG" 2>&1
PKG_AFTER=$(git rev-parse HEAD:package-lock.json 2>/dev/null || true)
if [ "$PKG_BEFORE" != "$PKG_AFTER" ]; then npm ci --omit=dev >> "$LOG" 2>&1; fi
if [ -n "$COMMANDS_CHANGED" ]; then node deploy-commands.js >> "$LOG" 2>&1; fi
sudo /usr/bin/systemctl restart pariahbot.service
echo "$(date -Is) deployed $REMOTE, service restarted" >> "$LOG"
EOF
	chmod 755 "$SYNC_FILE"
	cat > /etc/sudoers.d/pariahbot-sync <<EOF
$BOT_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart pariahbot.service
EOF
	chmod 440 /etc/sudoers.d/pariahbot-sync
	{ crontab_without "$BOT_USER" "$SYNC_FILE"; printf '0,15,30,45 * * * * %s\n' "$SYNC_FILE"; } | crontab -u "$BOT_USER" -
else
	rm -f "$SYNC_FILE" /etc/sudoers.d/pariahbot-sync
	# And its crontab line, or cron keeps trying to run the missing script.
	if crontab -u "$BOT_USER" -l >/dev/null 2>&1; then
		crontab_without "$BOT_USER" "$SYNC_FILE" | crontab -u "$BOT_USER" -
	fi
fi

# Register the current slash commands immediately, then start the service.
sudo -u "$BOT_USER" HOME="$BOT_HOME" bash -lc 'cd /opt/PariahBot && . "$HOME/.nvm/nvm.sh" && nvm use 24 >/dev/null && node deploy-commands.js'
systemctl restart pariahbot.service
printf 'PariahBot setup complete. Configuration is in %s.\n' "$CONFIG_FILE"
print_intent_steps

print_dashboard_steps
