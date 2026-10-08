FROM node:22-alpine AS build

RUN apk add --no-cache build-base cairo-dev pango-dev jpeg-dev giflib-dev

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine

RUN apk add --no-cache cairo pango jpeg giflib

WORKDIR /app
COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY assets/mascot ./assets/mascot
COPY assets/ocr ./assets/ocr
COPY README.md LICENSE ./

EXPOSE 3456

ENV NODE_ENV=production

ENTRYPOINT ["node", "dist/cli.js"]
# Listening on all interfaces requires a token: docker run -e DUCT_AUTH_TOKEN=... -p 3456:3456 duct
CMD ["serve", "--port", "3456", "--host", "0.0.0.0"]
