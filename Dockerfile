FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

ENV PORT=3001
ENV container=docker
EXPOSE 3001

CMD ["node", "server/index.js"]
