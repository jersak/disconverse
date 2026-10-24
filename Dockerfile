# Builds the backend image, which also serves the built web client.

FROM node:24-slim AS client
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci
COPY client client
RUN npm run build -w client

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY server/src server/src
COPY --from=client /app/client/dist client/dist
RUN mkdir /data && chown node:node /data

ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/data CLIENT_DIST=/app/client/dist
USER node
WORKDIR /app/server
EXPOSE 3000
CMD ["node", "src/index.ts"]
