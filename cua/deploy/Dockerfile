# Optional headless browser runtime. Desktop (native) control is macOS-only and
# is not included here. This image is provided for a Linux/CI deployment path;
# it was NOT built in the delivery environment because the Docker daemon was
# not running. Do not present it as verified until `docker compose build` and
# the HTTP smoke test have actually run.
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates bubblewrap fonts-liberation libnss3 libatk-bridge2.0-0 \
    libgtk-3-0 libgbm1 libasound2 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libxkbcommon0 libpango-1.0-0 libcups2 libdrm2 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
COPY console ./console
COPY scripts ./scripts
COPY native ./native
RUN npx playwright install --with-deps chromium && npm run build
RUN groupadd --gid 10001 cua && useradd --uid 10001 --gid cua --create-home cua \
 && mkdir -p /data && chown cua:cua /data && chmod 700 /data \
 && chmod -R a+rX /ms-playwright

ENV NODE_ENV=production
ENV CUA_DATA_DIR=/data
USER cua
EXPOSE 4317
CMD ["node", "dist/cli.js", "serve", "--host", "0.0.0.0", "--port", "4317"]
