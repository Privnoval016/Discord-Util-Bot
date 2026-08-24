# Multi-stage: build with dev deps, ship without them.
FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Run unprivileged. `node` (uid 1000) ships with the base image.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

ENV DATA_DIR=/data
VOLUME ["/data"]

# No ports exposed: the bot makes only outbound connections.
CMD ["node", "dist/src/index.js"]
