FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --include=dev --ignore-scripts
COPY scripts ./scripts
COPY dashboard ./dashboard
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /build/dist ./dist
COPY --chown=node:node server ./server
COPY --chown=node:node package.json LICENSE ./
USER node
EXPOSE 3210
CMD ["node", "server/main.mjs"]
