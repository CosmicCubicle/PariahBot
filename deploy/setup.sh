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

# Install native build tools, media support, Git, and the utilities needed by NVM.
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y build-essential ca-certificates curl ffmpeg git python3

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

# Create the private runtime environment from the checked-in template on first setup.
if [ ! -f "$CONFIG_FILE" ]; then
	cp "$INSTALL_DIR/.env.example" "$CONFIG_FILE"
	chown "$BOT_USER:$BOT_USER" "$CONFIG_FILE"
	chmod 600 "$CONFIG_FILE"
	printf 'Created %s from .env.example.\n' "$CONFIG_FILE"
fi

# Read existing values so rerunning setup preserves configuration unless replaced.
get_value() {
	awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$CONFIG_FILE" 2>/dev/null || true
}

ask_required() {
	local prompt=$1 default=${2:-} value
	while :; do
		if [ -n "$default" ]; then
			read -r -p "$prompt [$default]: " value
			value=${value:-$default}
		else
			read -r -p "$prompt: " value
		fi
		[ -n "$value" ] && { printf '%s' "$value"; return; }
		printf 'A value is required.\n' >&2
	done
}

# Prompt privately for the token while allowing an existing token to be retained.
ask_token() {
	local current=$1 value
	read -r -s -p 'Discord bot token: ' value
	printf '\n'
	if [ -n "$value" ]; then
		printf '%s' "$value"
	elif [ -n "$current" ] && [ "$current" != your-bot-token-here ]; then
		printf '%s' "$current"
	else
		printf 'A token is required.\n' >&2
		ask_token "$current"
	fi
}

# Collect the Discord credentials used for command registration and bot login.
TOKEN=$(ask_token "$(get_value DISCORD_TOKEN)")
CLIENT_ID=$(ask_required 'Discord application/client ID' "$(get_value CLIENT_ID)")
GUILD_ID=$(ask_required 'Discord guild ID (used for instant command registration)' "$(get_value GUILD_ID)")

DISCORD_TOKEN_VALUE="$TOKEN" CLIENT_ID_VALUE="$CLIENT_ID" GUILD_ID_VALUE="$GUILD_ID" \
node - "$CONFIG_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const values = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN_VALUE,
  CLIENT_ID: process.env.CLIENT_ID_VALUE,
  GUILD_ID: process.env.GUILD_ID_VALUE,
};
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
for (const [key, value] of Object.entries(values)) {
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const replacement = `${key}=${value}`;
  if (index === -1) lines.push(replacement);
  else lines[index] = replacement;
}
fs.writeFileSync(file, `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`, { mode: 0o600 });
NODE

# Keep credentials readable only by the bot user.
chown "$BOT_USER:$BOT_USER" "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

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
	current=$(crontab -u "$BOT_USER" -l 2>/dev/null || true)
	printf '%s\n' "$current" | grep -vF "$SYNC_FILE" | { cat; printf '0,15,30,45 * * * * %s\n' "$SYNC_FILE"; } | crontab -u "$BOT_USER" -
else
	rm -f "$SYNC_FILE" /etc/sudoers.d/pariahbot-sync
fi

# Register the current slash commands immediately, then start the service.
sudo -u "$BOT_USER" HOME="$BOT_HOME" bash -lc 'cd /opt/PariahBot && . "$HOME/.nvm/nvm.sh" && nvm use 24 >/dev/null && node deploy-commands.js'
systemctl restart pariahbot.service
printf 'PariahBot setup complete. Configuration is in %s.\n' "$CONFIG_FILE"