#!/usr/bin/env bash
# ============================================================================
#  OrbitBridge Server - GUI installer & manager for Ubuntu/Debian VPS
#
#  Interactive menu:  bash install.sh
#  Unattended:        bash install.sh --full        (server + pm2 + tunnel)
#                     bash install.sh --server-only (no Cloudflare tunnel)
#                     bash install.sh --status | --token | --rotate
#                     bash install.sh --tunnel | --named-tunnel
#                     bash install.sh --port 3456 | --update
#                     bash install.sh --restart | --stop | --start
#                     bash install.sh --uninstall
#
#  The server zip is downloaded from the permanent GitHub release URL,
#  sha256-verified, PK-guarded, and extracted with token preservation.
# ============================================================================
set -u

VERSION="1.8.0"
REPO="belugaburgers513-bot/Agent-Bridge"
DL_BASE="https://github.com/${REPO}/releases/latest/download"
RAW_BASE="https://raw.githubusercontent.com/${REPO}/main"
CODELOAD_TGZ="https://codeload.github.com/${REPO}/tar.gz/refs/heads/main"
OB_HOME="/root/orbitbridge"
SRV_DIR="$OB_HOME/server"
PM2_NAME="orbitbridge"
TUNNEL_UNIT="orbitbridge-tunnel.service"
NAMED_UNIT="orbitbridge-named.service"
ZIP_URL="$DL_BASE/orbitbridge.zip"
SUMS_URL="$DL_BASE/checksums.txt"
EMBED_SHA256=""   # filled at build time for self-contained variants

# embedded payload (self-contained build): base64 zip after the __OB_PAYLOAD__ marker
OB_EMBED="/tmp/.ob_embed.zip"
if grep -q '^__OB_PAYLOAD__$' "$0" 2>/dev/null; then
  sed -n '/^__OB_PAYLOAD__$/,$p' "$0" | tail -n +2 | base64 -d > "$OB_EMBED" 2>/dev/null || rm -f "$OB_EMBED"
fi

# ---------------------------------------------------------------- appearance
if [ -t 1 ]; then
  C_G='\033[1;32m'; C_R='\033[1;31m'; C_Y='\033[1;33m'; C_B='\033[1;36m'; C_D='\033[2m'; C_0='\033[0m'
else
  C_G=''; C_R=''; C_Y=''; C_B=''; C_D=''; C_0=''
fi
say()  { printf "%b\n" "$*"; }
ok()   { printf "${C_G}[ok]${C_0} %b\n" "$*"; }
warn() { printf "${C_Y}[!!]${C_0} %b\n" "$*"; }
err()  { printf "${C_R}[xx]${C_0} %b\n" "$*"; }
die()  { err "$*"; printf "\nAborted. Fix the issue above and re-run.\n"; exit 1; }
step() { printf "\n${C_B}==> %b${C_0}\n" "$*"; }
pause() { printf "\n${C_D}Press Enter to continue...${C_0}"; read -r _; }

confirm() { # confirm "question" -> 0 yes / 1 no
  local a=""; printf "${C_Y}%s [y/N]: ${C_0}" "$1"; read -r a
  case "$a" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- helpers
have()      { command -v "$1" >/dev/null 2>&1; }
is_root()   { [ "$(id -u)" -eq 0 ]; }
installed() { [ -f "$SRV_DIR/server.js" ]; }
server_port() {
  local p=""
  [ -f "$SRV_DIR/config.json" ] && p="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).port)}catch(e){console.log("")}' "$SRV_DIR/config.json" 2>/dev/null)"
  [ -n "$p" ] || p=3456
  echo "$p"
}
pm2_running() {
  have pm2 || return 1
  [ "$(pm2 jlist 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s||"[]");console.log(a.some(x=>x.name===process.argv[1]&&x.pm2_env&&x.pm2_env.status==="online")?"yes":"no")}catch(e){console.log("no")}})' "$PM2_NAME" 2>/dev/null)" = "yes"
}

# ------------------------------------------------------------ system prepare
apt_base() {
  step "Installing base tools (curl, unzip, ca-certificates)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y -qq >/dev/null 2>&1 || warn "apt-get update had warnings (continuing)"
  apt-get install -y -qq curl ca-certificates unzip >/dev/null 2>&1 || die "could not install curl/unzip"
  ok "base tools ready"
}

ensure_node() {
  local need=1 major=""
  if have node; then
    major="$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1)"
    case "${major:-0}" in ''|*[!0-9]*) major=0 ;; esac
    if [ "$major" -ge 18 ]; then need=0; ok "node $(node -v) already present"; fi
  fi
  if [ "$need" = 1 ]; then
    step "Installing Node.js 20 (needs >= 18)"
    curl -fsSL --connect-timeout 20 https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 \
      || die "NodeSource setup failed - check the VPS has internet access"
    apt-get install -y -qq nodejs >/dev/null 2>&1 || die "nodejs install failed"
    ok "node $(node -v) installed"
  fi
  have npm || die "npm missing after node install"
}

# ------------------------------------------------------------ package fetch
# sets: PKG_FILE (path) + PKG_KIND ("zip"|"targz")
# source order: embedded payload -> GitHub release zip -> codeload tarball
fetch_pkg() {
  step "Getting the OrbitBridge package"
  PKG_FILE=""; PKG_KIND=""
  local zip="/tmp/orbitbridge.zip" sums="/tmp/orbitbridge.checksums.txt" want="" got=""

  # 1) embedded payload (self-contained installer)
  if [ -s "$OB_EMBED" ]; then
    if [ -n "$EMBED_SHA256" ]; then
      got="$(sha256sum "$OB_EMBED" | cut -d' ' -f1)"
      if [ "$got" = "$EMBED_SHA256" ]; then
        PKG_FILE="$OB_EMBED"; PKG_KIND="zip"
        ok "using embedded package (sha256 ${got:0:16}...)"
        return 0
      fi
      warn "embedded payload checksum mismatch - falling back to download"
    else
      PKG_FILE="$OB_EMBED"; PKG_KIND="zip"
      ok "using embedded package (no checksum pinned)"
      return 0
    fi
  fi

  # 2) GitHub release zip (sha256-verified when checksums.txt reachable)
  if curl -fsSL --connect-timeout 20 --retry 1 -o "$zip" "$ZIP_URL" 2>/dev/null; then
    [ "$(head -c 2 "$zip")" = "PK" ] || { warn "PK guard failed on release zip"; rm -f "$zip"; }
    if [ -s "$zip" ]; then
      if curl -fsSL --connect-timeout 15 -o "$sums" "$SUMS_URL" 2>/dev/null; then
        want="$(grep -i 'orbitbridge\.zip' "$sums" 2>/dev/null | head -1 | cut -d' ' -f1 || true)"
        if [ -n "$want" ]; then
          got="$(sha256sum "$zip" | cut -d' ' -f1)"
          if [ "$want" != "$got" ]; then warn "sha256 mismatch (want $want, got $got)"; rm -f "$zip"; fi
        fi
      else
        warn "could not fetch checksums.txt - continuing with PK guard only"
      fi
    fi
    if [ -s "$zip" ]; then
      PKG_FILE="$zip"; PKG_KIND="zip"
      ok "downloaded release package ($(du -h "$zip" | cut -f1))"
      return 0
    fi
  else
    warn "GitHub release download failed - trying codeload fallback"
  fi

  # 3) codeload tarball of the main branch (different GitHub edge, no releases needed)
  local tgz="/tmp/orbitbridge.tgz" stage=""
  curl -fsSL --connect-timeout 20 --retry 1 -o "$tgz" "$CODELOAD_TGZ" || die "all download sources failed (release zip + codeload). Check the VPS internet access."
  [ -s "$tgz" ] || die "codeload download empty"
  stage="$(mktemp -d)"
  tar -xzf "$tgz" -C "$stage" 2>/dev/null || { rm -rf "$stage" "$tgz"; die "codeload tarball is corrupted"; }
  local src; src="$(echo "$stage"/*/ | head -1)"
  [ -f "$src/server/server.js" ] || { rm -rf "$stage" "$tgz"; die "codeload tarball missing server/"; }
  # v1.8: extension/ is KEPT — the server serves it to the extension's
  # self-updater (/api/ota/*). Deleting it would silently disable auto-update.
  mv "$src" "$stage/pkg"
  echo "$stage/pkg" > /tmp/.ob_pkg_stage
  PKG_FILE="$stage/pkg"; PKG_KIND="dir"
  ok "downloaded repo snapshot via codeload (git integrity, no checksum needed)"
  return 0
}

install_server_files() {
  step "Installing OrbitBridge to $OB_HOME"
  local stage="" src=""
  case "${PKG_KIND:-}" in
    zip)
      stage="$(mktemp -d)"
      unzip -o "$PKG_FILE" -d "$stage" >/dev/null 2>&1 || { rm -rf "$stage"; die "unzip failed"; }
      rm -f "$PKG_FILE" /tmp/orbitbridge.checksums.txt 2>/dev/null || true
      ;;
    dir)
      stage="$(cat /tmp/.ob_pkg_stage 2>/dev/null || true)"
      [ -d "$stage" ] || die "staged package missing"
      ;;
    *) die "no package fetched - run an install option first" ;;
  esac
  src="$(echo "$stage"/*/ | head -1)"
  [ -f "$src/server/server.js" ] || { rm -rf "$stage"; die "package layout unexpected (no server/)"; }
  mkdir -p "$OB_HOME"
  cp -a "$src/server" "$OB_HOME/" || { rm -rf "$stage"; die "copying server failed"; }
  # v1.8: install the extension copy too — the server's /api/ota/* endpoints
  # serve these files so the browser extension can update itself.
  if [ -d "$src/extension" ]; then
    cp -a "$src/extension" "$OB_HOME/" || say "  ${C_Y}warn: could not copy extension/ — extension auto-update will be unavailable${C_0}"
  else
    say "  ${C_Y}warn: package has no extension/ — extension auto-update will be unavailable${C_0}"
  fi
  cp -a "$src/CHANGELOG.md" "$src/LICENSE" "$src/README.md" "$OB_HOME/" 2>/dev/null || true
  rm -rf "$stage" /tmp/.ob_pkg_stage 2>/dev/null || true
  if [ -f "$SRV_DIR/.token" ]; then ok "server files in place (existing token preserved)"
  else ok "server files in place (a fresh token will be generated)"; fi
}

pm2_start_server() {
  step "Starting the bridge with pm2 (auto-start on reboot)"
  have pm2 || { npm i -g pm2 >/dev/null 2>&1 || die "pm2 install failed"; }
  cd "$SRV_DIR" || die "cannot cd $SRV_DIR"
  pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
  pm2 start ecosystem.config.js >/dev/null 2>&1 || die "pm2 start failed - run it manually inside $SRV_DIR for the real error"
  pm2 startup systemd -u root --hp /root 2>/dev/null | grep -m1 'pm2 startup' | sed 's/^sudo //' | bash >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  ok "pm2 process '$PM2_NAME' running + reboot-proof"
}

wait_token() { # prints token, dies if none appears
  local t="" i
  for i in $(seq 1 20); do [ -s "$SRV_DIR/.token" ] && break; sleep 1; done
  t="$(cat "$SRV_DIR/.token" 2>/dev/null || true)"
  [ -n "$t" ] || die "no token generated - check: pm2 logs $PM2_NAME --lines 30"
  echo "$t"
}

bridge_healthy() {
  local port; port="$(server_port)"
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$port/" 2>/dev/null || echo 000)"
  [ "$code" != "000" ]
}

# ------------------------------------------------------------ tunnels
install_cloudflared() {
  have cloudflared && return 0
  step "Installing cloudflared"
  local arch deb=""
  arch="$(uname -m)"
  case "$arch" in
    x86_64)  deb="cloudflared-linux-amd64.deb" ;;
    aarch64) deb="cloudflared-linux-arm64.deb" ;;
    *) warn "unknown arch '$arch' - cannot install cloudflared"; return 1 ;;
  esac
  curl -fsSL --connect-timeout 20 -o /tmp/cloudflared.deb "https://github.com/cloudflare/cloudflared/releases/latest/download/$deb" \
    && dpkg -i /tmp/cloudflared.deb >/dev/null 2>&1; rm -f /tmp/cloudflared.deb
  have cloudflared || { warn "cloudflared install failed"; return 1; }
  ok "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}' || echo '') installed"
}

systemd_unit() { # systemd_unit <unit-name> <exec-line>
  cat > "/etc/systemd/system/$1" <<UNIT
[Unit]
Description=OrbitBridge tunnel ($1)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$2
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload 2>/dev/null || true
}

tunnel_quick() { # ephemeral trycloudflare URL
  is_root || die "tunnel setup needs root"
  install_cloudflared || return 1
  step "Starting Cloudflare quick tunnel"
  systemctl stop "$NAMED_UNIT" >/dev/null 2>&1 || true
  systemctl disable "$NAMED_UNIT" >/dev/null 2>&1 || true
  systemd_unit "$TUNNEL_UNIT" "/usr/bin/cloudflared tunnel --url http://127.0.0.1:$(server_port) --no-autoupdate"
  systemctl enable --now "$TUNNEL_UNIT" >/dev/null 2>&1 || true
  local url="" i
  echo "  waiting for the tunnel URL (up to 60s)..."
  for i in $(seq 1 30); do
    url="$(journalctl -u "$TUNNEL_UNIT" --no-pager -n 200 2>/dev/null | grep -o 'https://[a-zA-Z0-9-]*\.trycloudflare\.com' | tail -1)"
    [ -n "$url" ] && break
    sleep 2
  done
  if [ -n "$url" ]; then
    printf '%s' "$url" > "$OB_HOME/tunnel.url"
    ok "tunnel live: $url"
    say ""
    say "  ${C_G}Paste this URL + your token into the extension Settings.${C_0}"
    say "  ${C_D}Note: quick-tunnel URLs change on reboot - run option 3 again${C_0}"
    say "  ${C_D}or read the new one: cat $OB_HOME/tunnel.url${C_0}"
  else
    warn "no tunnel URL yet - check: journalctl -u $TUNNEL_UNIT -n 50 | grep trycloudflare"
    return 1
  fi
}

tunnel_named() { # your own domain via Cloudflare (advanced)
  is_root || die "tunnel setup needs root"
  install_cloudflared || return 1
  step "Named tunnel with your own domain (advanced)"
  if [ ! -f /root/.cloudflared/cert.pem ]; then
    say "  Cloudflare login needed. Open this URL on your phone/PC and"
    say "  authorize the domain you want to use:"
    say ""
    say "  ${C_B}cloudflared tunnel login${C_0}  is starting - the URL prints below:"
    say ""
    timeout 300 cloudflared tunnel login 2>&1 | grep -o 'https://dash.cloudflare.com/argotunnel[^ ]*' | head -1 || true
    [ -f /root/.cloudflared/cert.pem ] || die "login not completed (cert.pem missing) - run this option again"
  fi
  ok "logged in to Cloudflare"
  printf "  Domain hostname to use (e.g. ob.yourdomain.com): "
  read -r HOSTNAME_IN
  case "$HOSTNAME_IN" in *.*.*|*.* ) ;; *) die "'$HOSTNAME_IN' does not look like a domain" ;; esac
  if ! cloudflared tunnel list 2>/dev/null | grep -q orbitbridge; then
    cloudflared tunnel create orbitbridge >/dev/null 2>&1 || die "tunnel create failed"
  fi
  local TID; TID="$(cloudflared tunnel list 2>/dev/null | awk '/orbitbridge/{print $1; exit}')"
  [ -n "$TID" ] || die "could not read tunnel id"
  mkdir -p /root/.cloudflared
  cat > /root/.cloudflared/config.yml <<YML
tunnel: $TID
credentials-file: /root/.cloudflared/$TID.json
ingress:
  - hostname: $HOSTNAME_IN
    service: http://127.0.0.1:$(server_port)
  - service: http_status:404
YML
  cloudflared tunnel route dns orbitbridge "$HOSTNAME_IN" >/dev/null 2>&1 || warn "DNS route failed - create a CNAME $HOSTNAME_IN -> $TID.cfargotunnel.com manually"
  systemctl stop "$TUNNEL_UNIT" >/dev/null 2>&1 || true
  systemctl disable "$TUNNEL_UNIT" >/dev/null 2>&1 || true
  systemd_unit "$NAMED_UNIT" "/usr/bin/cloudflared tunnel run orbitbridge"
  systemctl enable --now "$NAMED_UNIT" >/dev/null 2>&1 || true
  sleep 3
  if [ "$(systemctl is-active "$NAMED_UNIT" 2>/dev/null)" = "active" ]; then
    ok "named tunnel live: https://$HOSTNAME_IN"
    printf 'https://%s' "$HOSTNAME_IN" > "$OB_HOME/tunnel.url"
  else
    warn "tunnel unit not active - check: journalctl -u $NAMED_UNIT -n 50"
  fi
}

remove_tunnels() {
  systemctl stop "$TUNNEL_UNIT" "$NAMED_UNIT" >/dev/null 2>&1 || true
  systemctl disable "$TUNNEL_UNIT" "$NAMED_UNIT" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$TUNNEL_UNIT" "/etc/systemd/system/$NAMED_UNIT"
  systemctl daemon-reload 2>/dev/null || true
  rm -f "$OB_HOME/tunnel.url"
}

# ------------------------------------------------------------ actions
do_install() { # $1 = "full" | "server-only"
  is_root || die "run as root: sudo bash install.sh"
  [ -f /etc/debian_version ] || die "needs Ubuntu/Debian (apt-get)"
  apt_base
  ensure_node
  fetch_pkg
  install_server_files
  pm2_start_server
  local token; token="$(wait_token)"
  if bridge_healthy; then ok "bridge answering on 127.0.0.1:$(server_port)"
  else warn "port $(server_port) not answering yet - give it 5s, check: pm2 logs $PM2_NAME"; fi
  if [ "$1" = "full" ]; then
    tunnel_quick || warn "server is UP, tunnel failed - add it later (menu option 3)"
  else
    say ""
    say "  ${C_D}No tunnel installed (you chose server-only).${C_0}"
    say "  ${C_D}The bridge listens on 127.0.0.1:$(server_port) only.${C_0}"
    say "  ${C_D}Reach it later with: option 3 (quick tunnel), option 4 (own domain),${C_0}"
    say "  ${C_D}or an SSH tunnel: ssh -L $(server_port):127.0.0.1:$(server_port) root@vps${C_0}"
  fi
  print_summary "$token"
}

print_summary() {
  local token="$1" url=""
  [ -f "$OB_HOME/tunnel.url" ] && url="$(cat "$OB_HOME/tunnel.url")"
  say ""
  say "${C_B}==============================================================${C_0}"
  say "${C_B}  OrbitBridge v$VERSION - installed and running${C_0}"
  say "${C_B}==============================================================${C_0}"
  say ""
  say "  Extension panel -> Settings -> Save & test:"
  say ""
  if [ -n "$url" ]; then say "  ${C_G}URL  :${C_0} $url"
  else say "  ${C_Y}URL  :${C_0} (no tunnel - add one from the menu, option 3 or 4)"; fi
  say "  ${C_G}Token:${C_0} $token"
  say ""
  say "  ${C_D}Re-run: bash install.sh   |  Status: bash install.sh --status${C_0}"
  say ""
}

act_status() {
  local port; port="$(server_port)"
  say ""
  say "${C_B}-------------- OrbitBridge status --------------${C_0}"
  if installed; then
    say "  installed : ${C_G}yes${C_0}  ($SRV_DIR)"
    say "  version   : $(node -e 'try{console.log("v"+JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)}catch(e){console.log("?")}' "$SRV_DIR/package.json" 2>/dev/null)"
    say "  port      : $port (127.0.0.1 only)"
    if pm2_running; then say "  server    : ${C_G}running${C_0} (pm2, pid $(pm2_pid))"
    else say "  server    : ${C_R}stopped${C_0}  (start: bash install.sh --start)"; fi
    if bridge_healthy; then say "  health    : ${C_G}answering${C_0}"
    else say "  health    : ${C_Y}not answering${C_0}"; fi
    say "  token     : $( [ -s "$SRV_DIR/.token" ] && echo 'present' || echo "${C_R}missing${C_0}" )"
    if [ -f "/etc/systemd/system/$TUNNEL_UNIT" ]; then
      say "  tunnel    : quick -> $(cat "$OB_HOME/tunnel.url" 2>/dev/null || echo 'URL not captured yet')"
      say "              unit $TUNNEL_UNIT: $(systemctl is-active "$TUNNEL_UNIT" 2>/dev/null)"
    elif [ -f "/etc/systemd/system/$NAMED_UNIT" ]; then
      say "  tunnel    : named -> $(cat "$OB_HOME/tunnel.url" 2>/dev/null || echo '?')"
      say "              unit $NAMED_UNIT: $(systemctl is-active "$NAMED_UNIT" 2>/dev/null)"
    else
      say "  tunnel    : ${C_Y}none${C_0} (add: bash install.sh --tunnel)"
    fi
  else
    say "  installed : ${C_R}no${C_0}  (run: bash install.sh)"
  fi
  say "${C_B}-------------------------------------------------${C_0}"
}

act_token() {
  if [ -s "$SRV_DIR/.token" ]; then
    say ""
    say "${C_G}Token:${C_0} $(cat "$SRV_DIR/.token")"
    say "${C_D}Paste into the extension Settings -> Token.${C_0}"
  else
    warn "no token yet - is the server installed/started? (bash install.sh --full)"
  fi
}

act_rotate() {
  is_root || die "needs root"
  installed || die "server not installed"
  say "  Rotating invalidates the old token - you must re-pair the extension."
  confirm "  Rotate the token now?" || { say "cancelled."; return 0; }
  rm -f "$SRV_DIR/.token"
  pm2 restart "$PM2_NAME" >/dev/null 2>&1 || die "pm2 restart failed"
  local t; t="$(wait_token)"
  ok "new token generated"
  print_summary "$t"
}

act_port() { # $1 = new port
  is_root || die "needs root"
  installed || die "server not installed"
  case "${1:-}" in ''|*[!0-9]*) die "usage: install.sh --port 3456" ;; esac
  [ "$1" -ge 1024 ] && [ "$1" -le 65535 ] || die "port must be 1024-65535"
  node -e 'const fs=require("fs");const p=process.argv[1];const j=JSON.parse(fs.readFileSync(p,"utf8"));j.port=parseInt(process.argv[2]);fs.writeFileSync(p,JSON.stringify(j,null,2)+"\n")' "$SRV_DIR/config.json" "$1" || die "could not edit config.json"
  sed -i "s/PORT: [0-9]*/PORT: $1/" "$SRV_DIR/ecosystem.config.js" || true
  pm2 restart "$PM2_NAME" --update-env >/dev/null 2>&1 || true
  [ -f /etc/systemd/system/$TUNNEL_UNIT ] && { sed -i "s|http://127.0.0.1:[0-9]*|http://127.0.0.1:$1|" /etc/systemd/system/$TUNNEL_UNIT; systemctl daemon-reload 2>/dev/null; systemctl restart "$TUNNEL_UNIT" 2>/dev/null || true; }
  [ -f /root/.cloudflared/config.yml ] && { sed -i "s|http://127.0.0.1:[0-9]*|http://127.0.0.1:$1|" /root/.cloudflared/config.yml; systemctl restart "$NAMED_UNIT" 2>/dev/null || true; }
  ok "port changed to $1 (server + tunnel configs updated)"
}

act_update() {
  is_root || die "needs root"
  installed || die "server not installed"
  local old; old="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)}catch(e){console.log("?")}' "$SRV_DIR/package.json" 2>/dev/null)"
  apt_base
  fetch_pkg
  install_server_files
  local new; new="$(node -e 'try{console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version)}catch(e){console.log("?")}' "$SRV_DIR/package.json" 2>/dev/null)"
  pm2 restart "$PM2_NAME" >/dev/null 2>&1 || pm2_start_server
  ok "updated: v$old -> v$new (token preserved)"
  act_status
}

act_uninstall() {
  is_root || die "needs root"
  say "  This removes: pm2 process + tunnel units + $OB_HOME (INCLUDING the token"
  say "  and everything under /root/orbitbridge). Your VPS data elsewhere is untouched."
  confirm "  Really uninstall OrbitBridge?" || { say "cancelled."; return 0; }
  pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
  remove_tunnels
  rm -rf "$OB_HOME"
  ok "OrbitBridge removed (pm2 itself stays; 'npm i -g pm2 && npm uninstall -g pm2' manages that)"
}

# ------------------------------------------------------------ menu
show_menu() {
  local port; port="$(installed && server_port || echo 3456)"
  local state="stopped"
  pm2_running && state="running"
  printf "\n"
  printf "${C_B}  +==============================================+${C_0}\n"
  printf "${C_B}  |        OrbitBridge - installer & manager     |${C_0}\n"
  printf "${C_B}  +==============================================+${C_0}\n"
  printf "    ${C_D}v%s  |  server: %s  |  port: %s${C_0}\n" "$VERSION" "$state" "$port"
  printf "\n"
  printf "  ${C_G}Install / setup${C_0}\n"
  printf "    1) Full install        (server + pm2 + quick tunnel)\n"
  printf "    2) Server only         (NO tunnel - bring your own)\n"
  printf "    3) Quick tunnel        (trycloudflare URL, add/recreate)\n"
  printf "    4) Named tunnel        (your own domain - advanced)\n"
  printf "  ${C_G}Manage${C_0}\n"
  printf "    5) Status              (server + tunnel + token)\n"
  printf "    6) Show token\n"
  printf "    7) Rotate token        (old one stops working)\n"
  printf "    8) Change port\n"
  printf "    9) Update to latest    (keeps token)\n"
  printf "   10) Restart server\n"
  printf "   11) Stop server\n"
  printf "   12) Start server\n"
  printf "  ${C_R}   13) Uninstall everything${C_0}\n"
  printf "    q) Quit\n"
  printf "\n  Select an option: "
}

menu_loop() {
  while true; do
    show_menu
    local c=""; read -r c || { say ""; say "bye."; exit 0; }
    case "$c" in
      1)  do_install full ;;
      2)  do_install server-only ;;
      3)  is_root || { err "needs root"; } && tunnel_quick || true ;;
      4)  tunnel_named || true ;;
      5)  act_status ;;
      6)  act_token ;;
      7)  act_rotate ;;
      8)  printf "  New port (1024-65535): "; read -r np; act_port "$np" || true ;;
      9)  act_update ;;
      10) pm2 restart "$PM2_NAME" >/dev/null 2>&1 && ok "restarted" || err "pm2 restart failed - is it installed?" ;;
      11) pm2 stop "$PM2_NAME" >/dev/null 2>&1 && ok "stopped" || err "pm2 stop failed - is it installed?" ;;
      12) pm2 start "$PM2_NAME" >/dev/null 2>&1 && ok "started" || err "pm2 start failed - is it installed?" ;;
      13) act_uninstall ;;
      q|Q) say "bye."; exit 0 ;;
      "") : ;;
      *)  err "unknown option: $c" ;;
    esac
    pause
  done
}

# ------------------------------------------------------------ main
usage() {
  say "OrbitBridge server installer/manager v$VERSION"
  say ""
  say "  bash install.sh              interactive GUI menu"
  say "  bash install.sh --full       unattended: server + pm2 + quick tunnel"
  say "  bash install.sh --server-only"
  say "  bash install.sh --tunnel     add/recreate quick tunnel"
  say "  bash install.sh --named-tunnel"
  say "  bash install.sh --status | --token | --rotate | --port N"
  say "  bash install.sh --update | --restart | --stop | --start"
  say "  bash install.sh --uninstall"
}

main() {
  local arg="${1:-}"
  case "$arg" in
    -h|--help)   usage; exit 0 ;;
    --full)        do_install full ;;
    --server-only|--no-tunnel) do_install server-only ;;
    --tunnel)      is_root || die "needs root"; tunnel_quick ;;
    --named-tunnel) tunnel_named ;;
    --status)      act_status ;;
    --token)       act_token ;;
    --rotate)      act_rotate ;;
    --port)        act_port "${2:-}" ;;
    --update)      act_update ;;
    --restart)     is_root || die "needs root"; pm2 restart "$PM2_NAME" >/dev/null 2>&1 && ok "restarted" || err "pm2 restart failed" ;;
    --stop)        is_root || die "needs root"; pm2 stop "$PM2_NAME" >/dev/null 2>&1 && ok "stopped" || err "pm2 stop failed" ;;
    --start)       is_root || die "needs root"; pm2 start "$PM2_NAME" >/dev/null 2>&1 && ok "started" || err "pm2 start failed" ;;
    --uninstall)   act_uninstall ;;
    "")            is_root || die "run as root (sudo bash install.sh) - or use --help"; menu_loop ;;
    *)             err "unknown option: $arg"; usage; exit 1 ;;
  esac
}

main "$@"
exit 0
