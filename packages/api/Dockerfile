FROM node:22.23.3-bookworm-slim
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
WORKDIR /app
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/api/package.json packages/api/
COPY packages/cli/package.json packages/cli/
COPY packages/worker/package.json packages/worker/
RUN pnpm install --frozen-lockfile --filter @testbox/api...
COPY packages/shared packages/shared
COPY packages/api packages/api
RUN pnpm --filter @testbox/shared build && pnpm --filter @testbox/api build
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "packages/api/dist/main.js"]
