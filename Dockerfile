FROM oven/bun:1 AS base
WORKDIR /app

# Install Node.js (needed for Claude CLI), Claude CLI, and gosu
RUN apt-get update && apt-get install -y curl gosu && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN useradd -m -s /bin/bash appuser

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --production

# Copy app
COPY . .

# Create directories and set ownership
RUN mkdir -p /app/sessions /home/appuser/.claude && \
    chown -R appuser:appuser /app /home/appuser/.claude && \
    chmod +x /app/entrypoint.sh

EXPOSE 3000
CMD ["/app/entrypoint.sh"]
