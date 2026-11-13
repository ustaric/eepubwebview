FROM node:20-alpine

WORKDIR /app

# 의존성 우선 복사 및 프로덕션 패키지 설치
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

# 서버 소스 코드 복사
COPY . .

# 데이터 영구 저장소 폴더 보장
RUN mkdir -p /app/data

# Docker 컨테이너 외부 접속을 위한 기본 바인딩
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.js"]