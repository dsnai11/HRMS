FROM node:24-bookworm-slim
ENV NODE_ENV=production PORT=3000 DATABASE_PATH=/data/hrms.sqlite
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir /data && chown node:node /data
EXPOSE 3000
CMD ["node", "server/index.js"]
