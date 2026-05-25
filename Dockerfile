FROM node:22-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

FROM node:22-alpine

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY README.md LICENSE ./

EXPOSE 3456

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/cli.js"]
CMD ["serve", "--port", "3456"]
