# --- build the UI ---------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# --- runtime --------------------------------------------------------------
FROM node:22-alpine
# iputils ping understands -W; the file capability lets the non-root user send ICMP.
RUN apk add --no-cache iputils libcap && setcap cap_net_raw+ep /bin/ping
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY config/lab.example.yaml ./config/lab.example.yaml
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node_modules/.bin/tsx", "server/index.ts"]
