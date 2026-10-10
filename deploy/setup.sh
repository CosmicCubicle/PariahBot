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
	# To the terminal, not stdout: stdout is the captured token, and a newline
	# there wrote "DISCORD_TOKEN=" with the token on the line below it.
	printf '\n' >&2
	if [ -n "$value" ]; then
		printf '%s' "$value"
	elif [ -n "$current" ] && [ "$current" != your-bot-token-here ]; then
		printf '%s' "$current"
	else
		printf 'A token is required.\n' >&2
		ask_token "$current"
	fi
}

# The guild ID is optional: set, commands register to that one server
# instantly (for testing); empty, they register to every server the bot is in
# (for production). Enter keeps the current value; "none" clears it. A value
# that isn't a server ID (e.g. a stray space) counts as empty.
ask_guild_id() {
	local current=$1 value
	[[ "$current" =~ ^[0-9]{17,20}$ ]] || current=''
	while :; do
		read -r -p "Test server ID for instant command registration — leave empty in production [${current:-none}]: " value
		value=${value:-$current}
		[ "$value" = none ] && value=''
		if [ -z "$value" ] || [[ "$value" =~ ^[0-9]{17,20}$ ]]; then
			printf '%s' "$value"
			return
		fi
		printf 'A server ID is 17–20 digits. Leave it empty to register commands everywhere.\n' >&2
	done
}

# Prompt privately for a secret, keeping the current one when Enter is pressed.
ask_secret() {
	local prompt=$1 current=$2 value
	read -r -s -p "$prompt${current:+ [press Enter to keep the current one]}: " value
	printf '\n' >&2
	if [ -n "$value" ]; then
		printf '%s' "$value"
	elif [ -n "$current" ]; then
		printf '%s' "$current"
	else
		printf 'A value is required.\n' >&2
		ask_secret "$prompt" "$current"
	fi
}

ask_yes_no() {
	local reply
	read -r -p "$1 [y/N]: " reply
	[[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}

# Collect the Discord credentials used for command registration and bot login.
TOKEN=$(ask_token "$(get_value DISCORD_TOKEN)")
CLIENT_ID=$(ask_required 'Discord application/client ID' "$(get_value CLIENT_ID)")
GUILD_ID=$(ask_guild_id "$(get_value GUILD_ID)")

# Optional admin dashboard: a web page where server admins change settings,
# and the bot's owner also sees its status. It listens on this machine only
# (127.0.0.1); other computers reach it through an SSH tunnel, or a public
# address served by a Cloudflare Tunnel. Sign-in is with Discord, which needs
# the application's client secret. See the wiki's Admin Dashboard page.
DASHBOARD_PORT_VALUE=$(get_value DASHBOARD_PORT)
DISCORD_CLIENT_SECRET_VALUE=$(get_value DISCORD_CLIENT_SECRET)
DASHBOARD_PUBLIC_URL_VALUE=$(get_value DASHBOARD_PUBLIC_URL)
CONFIGURE_DASHBOARD=no
if [ -n "$DASHBOARD_PORT_VALUE" ]; then
	read -r -p "The admin dashboard is on (port $DASHBOARD_PORT_VALUE). Keep it on? [Y/n]: " KEEP_DASHBOARD
	if [[ "$KEEP_DASHBOARD" =~ ^[Nn]([Oo])?$ ]]; then
		DASHBOARD_PORT_VALUE=''
	elif ask_yes_no 'Change its settings?'; then
		CONFIGURE_DASHBOARD=yes
	fi
elif ask_yes_no 'Set up the admin dashboard (a web page for server admins)?'; then
	CONFIGURE_DASHBOARD=yes
fi
if [ "$CONFIGURE_DASHBOARD" = yes ]; then
	while :; do
		DASHBOARD_PORT_VALUE=$(ask_required 'Dashboard port' "${DASHBOARD_PORT_VALUE:-8080}")
		[[ "$DASHBOARD_PORT_VALUE" =~ ^[0-9]+$ ]] && [ "$DASHBOARD_PORT_VALUE" -ge 1024 ] && [ "$DASHBOARD_PORT_VALUE" -le 65535 ] && break
		printf 'Use a port number from 1024 to 65535.\n' >&2
	done
	printf '\nIn the Discord Developer Portal, open your application -> OAuth2.\n'
	printf 'Copy the Client Secret (Reset Secret if none is shown).\n'
	DISCORD_CLIENT_SECRET_VALUE=$(ask_secret 'Discord client secret' "$DISCORD_CLIENT_SECRET_VALUE")
	printf '\nIf admins will reach it at a public address, such as one served by a\n'
	printf 'Cloudflare Tunnel (https://pariahbot.example.com), enter it. Leave it blank\n'
	printf 'to open it on this machine or through an SSH tunnel.\n'
	while :; do
		read -r -p "Public address${DASHBOARD_PUBLIC_URL_VALUE:+ [$DASHBOARD_PUBLIC_URL_VALUE, or - to clear]}: " PUBLIC_URL_INPUT
		case "$PUBLIC_URL_INPUT" in
			'') break ;;
			-) DASHBOARD_PUBLIC_URL_VALUE=''; break ;;
			http://*|https://*) DASHBOARD_PUBLIC_URL_VALUE=${PUBLIC_URL_INPUT%/}; break ;;
			*) printf 'Start it with https:// (or http://).\n' >&2 ;;
		esac
	done
fi

# Written with the bot user's Node (installed through NVM above): root may
# have no node of its own on a fresh machine.
sudo -u "$BOT_USER" HOME="$BOT_HOME" \
	DISCORD_TOKEN_VALUE="$TOKEN" CLIENT_ID_VALUE="$CLIENT_ID" GUILD_ID_VALUE="$GUILD_ID" \
	DASHBOARD_PORT_VALUE="$DASHBOARD_PORT_VALUE" DISCORD_CLIENT_SECRET_VALUE="$DISCORD_CLIENT_SECRET_VALUE" DASHBOARD_PUBLIC_URL_VALUE="$DASHBOARD_PUBLIC_URL_VALUE" \
	bash -lc '. "$HOME/.nvm/nvm.sh" >/dev/null && nvm use 24 >/dev/null && node - "$0"' "$CONFIG_FILE" <<'NODE'
const fs = require('node:fs');
const file = process.argv[2];
const values = {
  DISCORD_TOKEN: process.env.DISCORD_TOKEN_VALUE,
  CLIENT_ID: process.env.CLIENT_ID_VALUE,
  GUILD_ID: process.env.GUILD_ID_VALUE,
  DASHBOARD_PORT: process.env.DASHBOARD_PORT_VALUE,
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET_VALUE,
  DASHBOARD_PUBLIC_URL: process.env.DASHBOARD_PUBLIC_URL_VALUE,
};
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
for (const [key, value] of Object.entries(values)) {
  const index = lines.findIndex((line) => line.startsWith(`${key}=`));
  const replacement = `${key}=${value ?? ''}`;
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

if [ -n "$DASHBOARD_PORT_VALUE" ]; then
	DASHBOARD_URL=${DASHBOARD_PUBLIC_URL_VALUE:-http://localhost:$DASHBOARD_PORT_VALUE}
	cat <<EOF

Admin dashboard: on, listening on 127.0.0.1:$DASHBOARD_PORT_VALUE (this machine only).

  1. In the Discord Developer Portal -> your application -> OAuth2 -> Redirects,
     add exactly:  ${DASHBOARD_URL%/}/auth/callback
EOF
	if [ -n "$DASHBOARD_PUBLIC_URL_VALUE" ]; then
		cat <<EOF
  2. Point $DASHBOARD_URL at this machine with a Cloudflare Tunnel:
     create the tunnel, run its "sudo cloudflared service install <token>"
     here, and add a public hostname with service HTTP, localhost:$DASHBOARD_PORT_VALUE.
     See the wiki's Admin Dashboard page (Cloudflare Tunnel).
EOF
	else
		cat <<EOF
  2. On this machine, open $DASHBOARD_URL
     From another computer, open an SSH tunnel first:
       ssh -L $DASHBOARD_PORT_VALUE:localhost:$DASHBOARD_PORT_VALUE $BOT_USER@$(hostname)
     then open $DASHBOARD_URL in that computer's browser.
EOF
	fi
	cat <<EOF
  3. In each Discord server, give your admins access:
       /setup admin-role add role:@YourAdminRole
     Members with that role, or Discord's Administrator permission, can sign
     in and see that server. Mod roles don't include the dashboard. The
     application's owner (or its team) sees every server.
EOF
fi