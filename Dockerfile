FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install
COPY server/ ./
COPY Cowboy/game.html ./game.html
EXPOSE 3000
CMD ["node", "index.js"]
