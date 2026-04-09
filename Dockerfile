FROM node:20-slim

RUN npx playwright install chromium --with-deps

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY dist/ ./dist/

ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/server.js"]
