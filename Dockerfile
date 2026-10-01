FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --omit=optional
COPY src ./src
COPY public ./public

RUN mkdir -p /data && chown node:node /data

ENV HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    FFMPEG_PATH=/usr/bin/ffmpeg
VOLUME /data
EXPOSE 3000
USER node
CMD ["npx", "tsx", "src/server.ts"]
