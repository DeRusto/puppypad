FROM node:22-bookworm-slim
WORKDIR /app
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
