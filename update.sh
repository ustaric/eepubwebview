cat << 'EOF' > /home/ubuntu/update.sh
#!/bin/bash
cd /home/ubuntu/eepubwebview && git pull && cp -af /home/ubuntu/eepubwebview/src/. /home/ubuntu/refresh-server/src/ && pm2 restart refresh-server
EOF
chmod +x /home/ubuntu/update.sh