FROM node:20-alpine

WORKDIR /app

# Generate a self-signed TLS cert so browsers allow microphone access over HTTPS
RUN apk add --no-cache openssl && \
    mkdir -p /app/server && \
    openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout /app/server/key.pem \
      -out /app/server/cert.pem \
      -days 3650 \
      -subj "/CN=intercom" \
      -addext "subjectAltName=IP:0.0.0.0,DNS:localhost"

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server ./server
COPY public ./public

RUN addgroup -S appgroup && adduser -S appuser -G appgroup && \
    chown -R appuser:appgroup /app
USER appuser

ENV PORT=3001
ENV container=docker
EXPOSE 3001

CMD ["node", "server/index.js"]
