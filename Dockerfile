FROM node:20-slim

RUN apt-get update && \
    apt-get install -y ffmpeg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY src ./src

EXPOSE $PORT
CMD ["node", "src/index.js"]
