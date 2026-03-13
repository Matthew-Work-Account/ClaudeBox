# Dockerfile -- claudebox devcontainer
# Base: debian:bookworm-slim with node user (created by useradd, not pre-existing).
# Language SDKs are NOT installed here; install-language.sh runs at container startup
# after project mounts are active to install only what the detected language requires.
# (ref: DL-002, DL-008)
#
# Sudoers entry scopes root access to init-firewall.sh and install-language.sh only;
# the node user cannot escalate for any other command. (ref: DL-010)
FROM debian:bookworm-slim

ARG USERNAME=node

ENV DEVCONTAINER=true

RUN echo "==> Installing system packages..." && \
    apt-get update && apt-get install -y --no-install-recommends \
    git \
    zsh \
    curl \
    wget \
    sudo \
    iptables \
    ipset \
    dnsmasq \
    dnsutils \
    jq \
    python3 \
    python3-pip \
    ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && echo "==> System packages installed."

RUN useradd -m -s /bin/zsh ${USERNAME}

RUN echo "==> Configuring sudoers..." && \
    echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh, /usr/local/bin/install-language.sh" > /etc/sudoers.d/claudebox \
    && chmod 0440 /etc/sudoers.d/claudebox

USER ${USERNAME}

RUN echo "==> Installing Claude Code..." && \
    curl -fsSL https://claude.ai/install.sh | bash \
    && echo "==> Claude Code installed."

USER root

COPY install-language.sh /usr/local/bin/install-language.sh
COPY install-dotnet.sh /usr/local/bin/install-dotnet.sh
COPY init-firewall.sh /usr/local/bin/init-firewall.sh
RUN chmod +x /usr/local/bin/install-language.sh /usr/local/bin/install-dotnet.sh /usr/local/bin/init-firewall.sh

USER ${USERNAME}

ENV PATH=/home/node/.local/bin:${PATH} \
    HOME=/home/node

WORKDIR /workspace
