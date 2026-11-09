# Internet relay: the server plus the phone web app, as one deployable service.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
# The desktop workspace is not needed here, so npm must not try to install it.
RUN node -e "const p=require('./package.json');p.workspaces=['packages/*','apps/server','apps/web'];require('fs').writeFileSync('package.json',JSON.stringify(p))"
RUN npm install --no-audit --no-fund
RUN npm run build -w packages/shared-types \
 && npm run build -w packages/relay-core \
 && npm run build -w apps/server \
 && npm run build -w apps/web
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine
ENV NODE_ENV=production PORT=3001 DATA_DIR=/data WEB_ROOT=/app/apps/web/dist
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/shared-types/package.json ./packages/shared-types/
COPY --from=build /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=build /app/packages/relay-core/package.json ./packages/relay-core/
COPY --from=build /app/packages/relay-core/dist ./packages/relay-core/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/server/dist/index.js"]
