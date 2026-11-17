FROM node:26-alpine AS deps
WORKDIR /app
COPY package*.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS dev
COPY . .
EXPOSE 3000
# ./src is bind-mounted over the image in docker-compose, so the generated client must be rebuilt at start.
CMD ["sh", "-c", "npx prisma generate && npx prisma migrate deploy && npm run dev"]

FROM deps AS build
COPY . .
RUN npm run build

FROM node:26-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/server.js"]
