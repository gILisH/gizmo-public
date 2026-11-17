# Stage 1 — install deps. better-sqlite3 is native; build tools guarantee a compile if
# no prebuild matches. They stay in this stage and never reach the runtime image.
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Yarn (classic, bundled in the node image) — the same tool `yarn add` uses locally, so
# the lockfile is authoritative. Install ALL deps: tsx + typescript are devDeps but needed
# at runtime (start = `tsx src/app.ts`). Clean the download cache — it doubled the layer.
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile && yarn cache clean

# Stage 2 — runtime. ffmpeg = voice notes; DejaVu = the Hebrew-capable font for PDFs (src/files).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json yarn.lock tsconfig.json ./
COPY src ./src
COPY SOUL.md ./SOUL.md

# State (SQLite, Baileys creds, Google token, per-user memory) lives on a volume.
ENV GIZMO_DB_PATH=/data/gizmo.db \
    GIZMO_MEMORY_DIR=/data/memory \
    GIZMO_CREDS_DIR=/data/creds/dedicated \
    GIZMO_PERSONAL_CREDS_DIR=/data/creds/personal \
    GOOGLE_TOKEN_PATH=/data/creds/google.json \
    GIZMO_OLLAMA_URL=http://ollama:11434

CMD ["yarn", "start"]
