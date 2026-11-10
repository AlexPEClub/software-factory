# Job-Image: Jeder Factory-Job läuft in einem eigenen Container aus diesem Image.
# Enthält Claude Code, GitHub CLI, git, Node und einen Chromium für Screenshots/E2E-Tests.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends git jq curl ca-certificates gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update -qq && apt-get install -y -qq gh \
 && rm -rf /var/lib/apt/lists/*

# Playwright als globales Paket (Browser sind im Basis-Image schon vorhanden)
RUN npm install -g playwright@1.65.0 && npm cache clean --force
ENV NODE_PATH=/usr/lib/node_modules

# Factory-Werkzeuge, Playbook und Workflow
COPY image/bin/ /usr/local/bin/
COPY image/entrypoint.sh /factory/entrypoint.sh
COPY image/preview.sh /factory/preview.sh
COPY image/improve.sh /factory/improve.sh
COPY playbooks/factory.md /factory/playbook.md
COPY playbooks/improve.md /factory/improve.md
COPY workflows/ /factory/workflows/
RUN chmod +x /usr/local/bin/factory-* /factory/entrypoint.sh /factory/preview.sh /factory/improve.sh

# Claude Code als normaler Nutzer installieren (offizieller Installer)
USER pwuser
ENV HOME=/home/pwuser
RUN curl -fsSL https://claude.ai/install.sh | bash
# Python-Projekte: uv (verwaltet Python-Versionen und Pakete selbst)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH=/home/pwuser/.local/bin:$PATH

WORKDIR /work
ENTRYPOINT ["/factory/entrypoint.sh"]
