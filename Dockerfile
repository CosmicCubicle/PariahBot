# PariahBot container image, published to ghcr.io by
# .github/workflows/container.yml. compose.yaml shows how to run it.
#
# Debian slim rather than Alpine: better-sqlite3 is pinned to a release with
# prebuilt glibc binaries (see state/db.js), so `npm ci` needs no compiler
# here either, matching deploy/setup.sh.
FROM node:24-bookworm-slim

# tini runs as PID 1 and passes `docker stop`'s SIGTERM on to node. Node as
# PID 1 ignores SIGTERM, so every stop would wait out the timeout and then be
# killed. Baked in rather than left to `docker run --init`, because the cloud
# platforms we document don't all offer that switch.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends tini \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# The code stays root-owned and read-only to the bot; only the database and
# the command log are writable. A named volume mounted on either starts out
# with this ownership.
RUN mkdir -p data logs && chown node:node data logs

# DASHBOARD_HOST keeps the bot's own default of 127.0.0.1. compose.yaml uses
# the host's network, where that is the host's loopback, as with systemd. Only
# a container on its own network, reached through `docker run -p`, needs
# DASHBOARD_HOST=0.0.0.0, and then -p 127.0.0.1:<port>:<port> decides who can
# reach it.
USER node

# Commands are registered on every start, so pulling a new image is the whole
# update; the systemd sync job does the same when commands/ changes. Discord
# treats an unchanged list as a no-op. deploy-commands.js logs a failure
# without exiting non-zero, so a Discord outage there doesn't stop the bot.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "node deploy-commands.js; exec node index.js"]
