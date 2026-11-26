#!/bin/bash
set -e
echo "1. Git 저장소 최신화..."
cd /home/ubuntu/eepubwebview
git pull

echo "2. src 폴더 복사..."
cp -af /home/ubuntu/eepubwebview/src/. /home/ubuntu/refresh-server/src/

echo "3. PM2 서버 재시작..."
pm2 restart refresh-server
echo "✅ 업데이트 완료!"
