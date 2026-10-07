# Version must match playwright-core in package.json
FROM mcr.microsoft.com/playwright:v1.56.1-noble
WORKDIR /shots
COPY package.json ./
RUN npm install --omit=dev
COPY worker.js ./
USER pwuser
CMD ["node", "worker.js"]
