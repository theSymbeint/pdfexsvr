FROM node:20-alpine

#RUN apk add --no-cache gcompat
WORKDIR /app

COPY . .

RUN npm install pnpm -g

RUN pnpm build


RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 hono


USER hono
EXPOSE 8080

CMD ["node", "/app/dist/index.js"]
