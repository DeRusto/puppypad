FROM node:22-bookworm-slim
WORKDIR /app
# git keeps members' file history (src/history.js)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY templates ./templates
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
CMD ["node", "src/server.js"]
