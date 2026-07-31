# better-sqlite3 는 네이티브 모듈이라 prebuild 가 있는 glibc 계열(slim)을 쓴다.
# alpine(musl)에서는 prebuild 가 없어 node-gyp 로 소스 빌드가 필요해 이미지가 무거워진다.
FROM node:22-slim

WORKDIR /app

# 의존성 레이어 캐시
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
