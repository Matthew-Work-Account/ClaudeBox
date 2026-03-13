#!/bin/bash
# init-firewall.sh -- container egress firewall
# Configures iptables to allow outbound traffic only to approved domains.
# Must run before language SDK installation so downloads go through approved
# channels. (ref: DL-010)
#
# Architecture: dnsmasq intercepts DNS lookups and adds resolved IPs to the
# 'allowed-ips' ipset automatically. iptables then accepts connections to any
# IP in that set and drops everything else. This handles CDN IP rotation
# because IPs are captured at lookup time rather than hard-coded at startup.
#
# Requires NET_ADMIN and NET_RAW capabilities (passed via --cap-add in
# claudebox.ps1 Invoke-Init). Runs as root (sudoers entry in Dockerfile).
#
# WARNING: NOT IDEMPOTENT. Re-running flushes the ipset then crashes when
# dnsmasq attempts to bind to an already-running instance (set -e + EADDRINUSE).
# Partial state after re-run: ipset empty, iptables rules stale.
#
# KNOWN ISSUE: sentry.io is in the allowlist but may be blocked intermittently.
# Root cause: dnsmasq ipset population is not guaranteed before iptables
# evaluates outbound connections at startup.
#
# ALLOWED_SUFFIXES entries match all subdomains, covering CDN edge nodes
# for azureedge.net, blob.core.windows.net, and similar patterns.
#
# Language-specific domains are appended from /tmp/claudebox-domains.json
# if that file exists. JSON structure: {"domains": [...], "suffixes": [...]}
set -e

echo "Initializing firewall..."

# Core domains and suffixes allowed for outbound connections.
# dnsmasq dynamically adds resolved IPs to the ipset at lookup time,
# so CDN IP rotation is handled automatically.
ALLOWED_DOMAINS=(
    "github.com"
    "api.github.com"
    "codeload.github.com"
    "objects.githubusercontent.com"
    "anthropic.com"
    "api.anthropic.com"
    "sentry.io"
    "statsig.anthropic.com"
    "statsig.com"
    "registry.npmjs.org"
    "npmjs.org"
    "registry.yarnpkg.com"
    "deb.debian.org"
    "security.debian.org"
)

# Suffix patterns: any subdomain of these is allowed (leading dot = wildcard).
ALLOWED_SUFFIXES=(
    "anthropic.com"
    "githubusercontent.com"
    "debian.org"
    "fastlydns.net"
    "fastly.net"
)

# Append language-specific domains from JSON if provided
DOMAINS_JSON="/tmp/claudebox-domains.json"
if [[ -f "$DOMAINS_JSON" ]]; then
    echo "Loading language domains from ${DOMAINS_JSON}..."
    while IFS= read -r domain; do
        [[ -n "$domain" ]] && ALLOWED_DOMAINS+=("$domain")
    done < <(jq -r '.domains[]?' "$DOMAINS_JSON")
    while IFS= read -r suffix; do
        [[ -n "$suffix" ]] && ALLOWED_SUFFIXES+=("$suffix")
    done < <(jq -r '.suffixes[]?' "$DOMAINS_JSON")
fi

# --- ipset ---
ipset create allowed-ips hash:ip 2>/dev/null || ipset flush allowed-ips

# --- Configure dnsmasq ---
DOCKER_DNS=$(grep nameserver /etc/resolv.conf | awk '{print $2}' | head -1)

# Build dnsmasq config: for each domain/suffix, tell dnsmasq to add
# resolved IPs to our ipset automatically.
DNSMASQ_CONF="/etc/dnsmasq.d/claudebox.conf"
mkdir -p /etc/dnsmasq.d

cat > "$DNSMASQ_CONF" <<EOF
# Forward to Docker's DNS
server=${DOCKER_DNS}
# Don't read /etc/resolv.conf (we set ourselves as resolver)
no-resolv
# Don't read /etc/hosts
no-hosts
# Listen only on localhost
listen-address=127.0.0.1
bind-interfaces
# Cache DNS results
cache-size=1000
EOF

# Add ipset rules for exact domains
for domain in "${ALLOWED_DOMAINS[@]}"; do
    echo "ipset=/${domain}/allowed-ips" >> "$DNSMASQ_CONF"
done

# Add ipset rules for suffix patterns (leading dot = all subdomains)
for suffix in "${ALLOWED_SUFFIXES[@]}"; do
    echo "ipset=/.${suffix}/allowed-ips" >> "$DNSMASQ_CONF"
    # Also match the suffix itself
    echo "ipset=/${suffix}/allowed-ips" >> "$DNSMASQ_CONF"
done

# Start dnsmasq
echo "Starting dnsmasq..."
dnsmasq --conf-dir=/etc/dnsmasq.d

# Point the system resolver at dnsmasq
echo "nameserver 127.0.0.1" > /etc/resolv.conf

# --- Pre-resolve domains to warm the ipset ---
echo "Warming DNS cache..."
for domain in "${ALLOWED_DOMAINS[@]}"; do
    dig +short "$domain" A @127.0.0.1 > /dev/null 2>&1 || true
done

# --- iptables rules ---

# Allow DNS to local dnsmasq
iptables -A OUTPUT -d 127.0.0.1 -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -d 127.0.0.1 -p tcp --dport 53 -j ACCEPT

# Allow dnsmasq to forward to Docker's DNS
if [ -n "$DOCKER_DNS" ]; then
    iptables -A OUTPUT -d "$DOCKER_DNS" -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -d "$DOCKER_DNS" -p tcp --dport 53 -j ACCEPT
fi

# Loopback & private networks
iptables -A OUTPUT -d 127.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT

# Allow established connections
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Allow connections to IPs in the ipset (dynamically populated by dnsmasq)
iptables -A OUTPUT -m set --match-set allowed-ips dst -j ACCEPT

# Drop everything else
iptables -A OUTPUT -j DROP

echo "Firewall initialized. Verifying connectivity..."

for domain in "api.anthropic.com" "github.com" "registry.npmjs.org"; do
    if curl -s --max-time 5 -o /dev/null "https://$domain" 2>/dev/null; then
        echo "  OK: $domain"
    else
        echo "  WARN: $domain unreachable (may be expected for some endpoints)"
    fi
done

echo "Firewall setup complete."
