# Shared by deploy/setup.sh (systemd) and deploy/container-setup.sh (Docker):
# the questions that fill in hom.env, and the dashboard instructions printed
# at the end. Sourced, not run on its own. Callers set CONFIG_FILE and BOT_USER
# first.
#
# Plain bash and awk, no Node: a container host has no Node of its own.

# Read KEY from CONFIG_FILE (or the file given), so rerunning setup preserves
# configuration unless replaced. Tolerates CRLF line endings from a file
# edited on Windows.
get_value() {
	awk -F= -v key="$1" '{ sub(/\r$/, "") } $1 == key { sub(/^[^=]*=/, ""); print; exit }' "${2:-$CONFIG_FILE}" 2>/dev/null || true
}

# Replace KEY=... in CONFIG_FILE, or append it. The value reaches awk through
# the environment rather than -v, which would expand backslashes in it.
set_value() {
	local tmp
	tmp=$(mktemp "$CONFIG_FILE.XXXXXX")
	chmod 600 "$tmp"
	KEY=$1 VALUE=$2 awk '
		{ sub(/\r$/, "") }
		index($0, ENVIRON["KEY"] "=") == 1 {
			if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"]
			done = 1
			next
		}
		{ print }
		END { if (!done) print ENVIRON["KEY"] "=" ENVIRON["VALUE"] }
	' "$CONFIG_FILE" > "$tmp"
	mv "$tmp" "$CONFIG_FILE"
}

# Print USER's crontab without the lines containing TEXT. grep -v exits 1 when
# no line is left (a crontab holding only that job), and under pipefail that
# ended setup.sh before it restarted the bot.
crontab_without() {
	{ crontab -u "$1" -l 2>/dev/null || true; } | { grep -vF "$2" || true; }
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

# Create CONFIG_FILE from the template on first run, then ask for the Discord
# credentials and the optional dashboard settings. Enter keeps each current
# value, so rerunning is safe. Leaves TOKEN, DASHBOARD_PORT_VALUE and
# DASHBOARD_PUBLIC_URL_VALUE set for the caller.
configure_bot_env() {
	local template=$1
	if [ ! -f "$CONFIG_FILE" ]; then
		cp "$template" "$CONFIG_FILE"
		chmod 600 "$CONFIG_FILE"
		printf 'Created %s from .env.example.\n' "$CONFIG_FILE"
	fi

	# Collect the Discord credentials used for command registration and bot login.
	TOKEN=$(ask_token "$(get_value DISCORD_TOKEN)")
	local client_id guild_id
	client_id=$(ask_required 'Discord application/client ID' "$(get_value CLIENT_ID)")
	guild_id=$(ask_guild_id "$(get_value GUILD_ID)")

	# Optional admin dashboard: a web page where server admins change settings,
	# and the bot's owner also sees its status. It listens on this machine only
	# (127.0.0.1); other computers reach it through an SSH tunnel, or a public
	# address served by a Cloudflare Tunnel. Sign-in is with Discord, which needs
	# the application's client secret. See the wiki's Admin Dashboard page.
	DASHBOARD_PORT_VALUE=$(get_value DASHBOARD_PORT)
	DASHBOARD_PUBLIC_URL_VALUE=$(get_value DASHBOARD_PUBLIC_URL)
	local client_secret configure_dashboard=no keep_dashboard public_url_input
	client_secret=$(get_value DISCORD_CLIENT_SECRET)
	if [ -n "$DASHBOARD_PORT_VALUE" ]; then
		read -r -p "The admin dashboard is on (port $DASHBOARD_PORT_VALUE). Keep it on? [Y/n]: " keep_dashboard
		if [[ "$keep_dashboard" =~ ^[Nn]([Oo])?$ ]]; then
			DASHBOARD_PORT_VALUE=''
		elif ask_yes_no 'Change its settings?'; then
			configure_dashboard=yes
		fi
	elif ask_yes_no 'Set up the admin dashboard (a web page for server admins)?'; then
		configure_dashboard=yes
	fi
	if [ "$configure_dashboard" = yes ]; then
		while :; do
			DASHBOARD_PORT_VALUE=$(ask_required 'Dashboard port' "${DASHBOARD_PORT_VALUE:-8080}")
			[[ "$DASHBOARD_PORT_VALUE" =~ ^[0-9]+$ ]] && [ "$DASHBOARD_PORT_VALUE" -ge 1024 ] && [ "$DASHBOARD_PORT_VALUE" -le 65535 ] && break
			printf 'Use a port number from 1024 to 65535.\n' >&2
		done
		printf '\nIn the Discord Developer Portal, open your application -> OAuth2.\n'
		printf 'Copy the Client Secret (Reset Secret if none is shown).\n'
		client_secret=$(ask_secret 'Discord client secret' "$client_secret")
		printf '\nIf admins will reach it at a public address, such as one served by a\n'
		printf 'Cloudflare Tunnel (https://pariahbot.example.com), enter it. Leave it blank\n'
		printf 'to open it on this machine or through an SSH tunnel.\n'
		while :; do
			read -r -p "Public address${DASHBOARD_PUBLIC_URL_VALUE:+ [$DASHBOARD_PUBLIC_URL_VALUE, or - to clear]}: " public_url_input
			case "$public_url_input" in
				'') break ;;
				-) DASHBOARD_PUBLIC_URL_VALUE=''; break ;;
				http://*|https://*) DASHBOARD_PUBLIC_URL_VALUE=${public_url_input%/}; break ;;
				*) printf 'Start it with https:// (or http://).\n' >&2 ;;
			esac
		done
	fi

	set_value DISCORD_TOKEN "$TOKEN"
	set_value CLIENT_ID "$client_id"
	set_value GUILD_ID "$guild_id"
	set_value DASHBOARD_PORT "$DASHBOARD_PORT_VALUE"
	set_value DISCORD_CLIENT_SECRET "$client_secret"
	set_value DASHBOARD_PUBLIC_URL "$DASHBOARD_PUBLIC_URL_VALUE"

	# Keep credentials readable only by the bot user.
	chown "$BOT_USER:$BOT_USER" "$CONFIG_FILE"
	chmod 600 "$CONFIG_FILE"
}

# The bot asks Discord for the privileged Server Members intent (and Message
# Content when SERVER_LOG_MESSAGE_CONTENT is on), and Discord refuses the
# login until the Developer Portal allows it — see lib/intents.js. A script
# can't switch it on, so it says so on every run.
print_intent_steps() {
	local message_content
	message_content=$(get_value SERVER_LOG_MESSAGE_CONTENT)
	cat <<EOF

Required once, in the Discord Developer Portal: your application -> Bot ->
Privileged Gateway Intents, switch on "Server Members Intent" and Save Changes.
Without it Discord refuses the bot's login, and the log says so.
EOF
	# Lowercased, to accept what lib/intents.js accepts (TRUE, Yes, …).
	if [[ "${message_content,,}" =~ ^(1|true|yes|on)$ ]]; then
		printf 'SERVER_LOG_MESSAGE_CONTENT is on, so also switch on "Message Content Intent".\n'
	fi
}

# The steps left to do by hand once the dashboard is on: register the redirect
# URL, then reach it through an SSH or Cloudflare Tunnel.
print_dashboard_steps() {
	[ -n "$DASHBOARD_PORT_VALUE" ] || return 0
	local url=${DASHBOARD_PUBLIC_URL_VALUE:-http://localhost:$DASHBOARD_PORT_VALUE}
	cat <<EOF

Admin dashboard: on, listening on 127.0.0.1:$DASHBOARD_PORT_VALUE (this machine only).

  1. In the Discord Developer Portal -> your application -> OAuth2 -> Redirects,
     add exactly:  ${url%/}/auth/callback
EOF
	if [ -n "$DASHBOARD_PUBLIC_URL_VALUE" ]; then
		cat <<EOF
  2. Point $url at this machine with a Cloudflare Tunnel:
     create the tunnel, run its "sudo cloudflared service install <token>"
     here, and add a public hostname with service HTTP, localhost:$DASHBOARD_PORT_VALUE.
     See the wiki's Admin Dashboard page (Cloudflare Tunnel).
EOF
	else
		cat <<EOF
  2. On this machine, open $url
     From another computer, open an SSH tunnel first:
       ssh -L $DASHBOARD_PORT_VALUE:localhost:$DASHBOARD_PORT_VALUE $BOT_USER@$(hostname)
     then open $url in that computer's browser.
EOF
	fi
	cat <<EOF
  3. In each Discord server, give your admins access:
       /setup admin-role add role:@YourAdminRole
     Members with that role, or Discord's Administrator permission, can sign
     in and see that server. Mod roles don't include the dashboard. The
     application's owner (or its team) sees every server.
EOF
}
