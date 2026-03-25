FROM oven/bun:1 AS base
WORKDIR /app

# Install Node.js (needed for Claude CLI) and Claude CLI
RUN apt-get update && apt-get install -y curl && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock* ./
RUN bun install --production

# Copy app
COPY . .

# Create sessions directory
RUN mkdir -p /app/sessions

EXPOSE 3000
CMD ["bun", "run", "server.js"]
