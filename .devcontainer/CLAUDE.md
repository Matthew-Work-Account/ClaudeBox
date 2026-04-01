# .devcontainer — CLAUDE.md

Container image definition and initialization scripts for ClaudeBox containers.

## Index

| File                   | Contents (WHAT)                                                                          | Read When (WHEN)                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `Dockerfile`           | Base image: debian:bookworm-slim; system packages (locales, zsh, git, etc.); node user; sudoers; default `.zshrc` baked in | Changing pre-installed packages, locale, default shell config, or image structure |
| `install-language.sh`  | Runtime language SDK installation; runs as root at container startup; sources node env; executes `extra_commands` | Adding language support, changing SDK install logic, debugging init failures |
| `install-dotnet.sh`    | .NET SDK installation helper invoked by `install-language.sh` for dotnet language config | Changing .NET version or install method                             |
| `init-firewall.sh`     | iptables/ipset firewall initialization; allows only approved domains; runs as root at startup | Changing firewall rules or adding domain allowlist behavior         |
