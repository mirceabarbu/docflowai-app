FROM node:20-slim

RUN apt-get update && apt-get install -y \
  libreoffice \
  libreoffice-writer \
  libreoffice-calc \
  libreoffice-impress \
  fonts-liberation \
  fonts-dejavu \
  --no-install-recommends \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV HOME=/tmp
EXPOSE 3000
CMD ["node", "server/index.mjs"]
