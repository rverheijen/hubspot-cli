#!/bin/sh
# Ensures the official hubspot Agent CLI is present and current whenever
# this wrapper is installed. Never fails the npm install itself - if this
# can't reach the network or the install/upgrade fails, bin/cli.js already
# gives a clear error at runtime if hubspot truly isn't on PATH.

INSTALL_URL="https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh"
MANUAL_HINT="Install manually: curl -fsSL $INSTALL_URL | sh"

if command -v hubspot >/dev/null 2>&1; then
  echo "hubspot-cli: found existing hubspot Agent CLI, checking for updates..."
  hubspot upgrade || echo "hubspot-cli: 'hubspot upgrade' failed, continuing anyway."
else
  echo "hubspot-cli: hubspot Agent CLI not found, installing..."
  TMP_INSTALLER="$(mktemp)"
  # Downloaded to a file (rather than piped directly into sh) so curl's own
  # exit code can be checked explicitly - piping into sh means the pipeline's
  # exit status is sh's, not curl's, which silently masks a download failure.
  if curl -fsSL "$INSTALL_URL" -o "$TMP_INSTALLER"; then
    sh "$TMP_INSTALLER" || echo "hubspot-cli: install script failed, continuing anyway. $MANUAL_HINT"
  else
    echo "hubspot-cli: could not download installer, continuing anyway. $MANUAL_HINT"
  fi
  rm -f "$TMP_INSTALLER"
fi

exit 0
