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
    tmux \
    python3 \
    python3-pip \
    ca-certificates \
    locales \
    && sed -i 's/# en_US.UTF-8/en_US.UTF-8/' /etc/locale.gen \
    && locale-gen \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && echo "==> System packages installed."

ENV LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

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

RUN cat > /home/node/.zshrc << 'ZSHRC'
# ClaudeBox default zsh configuration

# --- Environment ---
[ -f ~/.env.sh ] && source ~/.env.sh

# --- History ---
HISTSIZE=10000
SAVEHIST=10000
HISTFILE=~/.zsh_history
setopt HIST_IGNORE_DUPS HIST_IGNORE_SPACE SHARE_HISTORY INC_APPEND_HISTORY

# --- Completion ---
autoload -Uz compinit && compinit

# --- Prompt ---
autoload -U colors && colors
PROMPT='%F{cyan}%n%f:%F{blue}%~%f %# '

# --- Aliases ---
alias ll='ls -la --color=auto'
alias la='ls -A --color=auto'
alias l='ls -CF --color=auto'

# --- User customization ---
# Drop a .zshrc.local in your home dir (via extra_commands) for personal config
[ -f ~/.zshrc.local ] && source ~/.zshrc.local
ZSHRC

RUN cat > /home/node/.tmux.conf << 'TMUXCONF'
set -g mouse on
set -g history-limit 10000
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",xterm-256color:Tc"
TMUXCONF

ENV PATH=/home/node/.local/bin:${PATH} \
    HOME=/home/node

WORKDIR /workspace
