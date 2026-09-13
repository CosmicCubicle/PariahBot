#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONFIG_FILE=${PARIAHBOT_CONFIG_FILE:-"$SCRIPT_DIR/../hom.env"}
MODE=${1:-}

usage() {
	printf 'Usage: %s [--logging | --reset]\n' "$0"
}

get_value() {
	local line
	line=$(grep -m1 "^$1=" "$CONFIG_FILE" 2>/dev/null || true)
	printf '%s' "${line#*=}"
}

set_value() {
	local key=$1 value=$2
	node - "$CONFIG_FILE" "$key" "$value" <<'NODE'
const fs = require('node:fs');
const [file, key, value] = process.argv.slice(2);
const prefix = `${key}=`;
const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
const index = lines.findIndex((line) => line.startsWith(prefix));
if (index === -1) lines.push(`${prefix}${value}`);
else lines[index] = `${prefix}${value}`;
fs.writeFileSync(file, `${lines.filter((line, index) => line || index < lines.length - 1).join('\n')}\n`, { mode: 0o600 });
NODE
}

ask() {
	local prompt=$1 default=${2:-} value
	if [ -n "$default" ]; then
		read -r -p "$prompt [$default]: " value
		printf '%s' "${value:-$default}"
	else
		read -r -p "$prompt: " value
		printf '%s' "$value"
	fi
}

ask_required() {
	local prompt=$1 default=${2:-} value
	while :; do
		value=$(ask "$prompt" "$default")
		[ -n "$value" ] && { printf '%s' "$value"; return; }
		printf 'A value is required.\n' >&2
	done
}

ask_secret() {
	local prompt=$1 value
	while :; do
		read -r -s -p "$prompt: " value
		printf '\n'
		[ -n "$value" ] && { printf '%s' "$value"; return; }
		printf 'A value is required.\n' >&2
	done
}

confirm() {
	local reply
	read -r -p "$1 [y/N]: " reply
	[[ "$reply" =~ ^[Yy]([Ee][Ss])?$ ]]
}

configure_logging() {
	printf '\nDiscord command logging\n'
	if ! confirm 'Post command logs to Discord?'; then
		set_value LOG_CHANNEL_ID ''
		set_value LOG_CHANNEL_SUCCESS_ID ''
		set_value LOG_CHANNEL_ERROR_ID ''
		return
	fi

	if confirm 'Use one channel for both successful and failed commands?'; then
		set_value LOG_CHANNEL_ID "$(ask_required 'Shared log channel ID' "$(get_value LOG_CHANNEL_ID)")"
		set_value LOG_CHANNEL_SUCCESS_ID ''
		set_value LOG_CHANNEL_ERROR_ID ''
	else
		set_value LOG_CHANNEL_ID ''
		set_value LOG_CHANNEL_SUCCESS_ID "$(ask_required 'Success log channel ID' "$(get_value LOG_CHANNEL_SUCCESS_ID)")"
		set_value LOG_CHANNEL_ERROR_ID "$(ask_required 'Error log channel ID' "$(get_value LOG_CHANNEL_ERROR_ID)")"
	fi
}

configure_base() {
	printf 'PariahBot first-run configuration\n'
	set_value DISCORD_TOKEN "$(ask_secret 'Discord bot token')"
	set_value CLIENT_ID "$(ask_required 'Discord application/client ID')"
	set_value GUILD_ID "$(ask 'Discord guild ID (leave blank for global commands)' "$(get_value GUILD_ID)")"
	configure_logging
}

restart_services() {
	if ! command -v systemctl >/dev/null 2>&1; then
		return
	fi

	if confirm 'Restart PariahBot services now?'; then
		sudo systemctl restart pariahbot.service
	fi
}

is_first_run() {
	local token
	token=$(get_value DISCORD_TOKEN)
	[ -z "$token" ] || [ "$token" = 'your-bot-token-here' ]
}

mkdir -p "$(dirname "$CONFIG_FILE")"
touch "$CONFIG_FILE"
chmod 600 "$CONFIG_FILE"

case "$MODE" in
	'')
		if ! is_first_run; then
			printf 'Configuration already exists. Use --logging or --reset.\n' >&2
			usage
			exit 1
		fi
		configure_base
		;;
	--logging)
		configure_logging
		;;
	--reset)
		if ! confirm "Erase all settings in $CONFIG_FILE and start over?"; then
			printf 'Reset cancelled.\n'
			exit 0
		fi
		: > "$CONFIG_FILE"
		configure_base
		;;
	-h|--help)
		usage
		exit 0
		;;
	*)
		usage >&2
		exit 1
		;;
esac

restart_services
printf 'Configuration saved to %s.\n' "$CONFIG_FILE"
