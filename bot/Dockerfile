FROM node:22-slim

RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
COPY patches ./patches

RUN npm ci

COPY . .

CMD ["npm", "start"]
