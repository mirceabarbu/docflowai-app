FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
  libreoffice-writer \
  libreoffice-calc \
  libreoffice-impress \
  libreoffice-draw \
  fonts-liberation \
  fonts-dejavu-core \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

ENV HOME=/tmp
EXPOSE 3000
CMD ["node", "server/index.mjs"]
