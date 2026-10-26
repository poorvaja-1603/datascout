#!/usr/bin/env bash
# ==============================================================================
# DataScout EC2 Dataset Background Worker - UserData Bootstrap Script
# ==============================================================================
# Automatically configures an Amazon EC2 instance (Amazon Linux 2023 or Ubuntu)
# to run the DataScout continuous dataset ingestion & deep inspection daemon.
#
# IAM Role: Uses 'LabRole' attached to the EC2 instance for seamless S3,
# DynamoDB, and EventBridge access without hardcoded credentials.
# ==============================================================================

set -euo pipefail

echo "==> [DataScout] Initializing EC2 Worker setup..."

# 1. Update OS and install Node.js 22 & Git
if command -v dnf &> /dev/null; then
  dnf update -y
  dnf install -y git
  # Install Node.js 22 LTS
  curl -fsSL https://rpm.nodesource.com/setup_22.x | bash -
  dnf install -y nodejs
elif command -v apt-get &> /dev/null; then
  apt-get update -y
  apt-get install -y git curl
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

node --version
npm --version

# 2. Setup DataScout application directory
APP_DIR="/opt/datascout"
mkdir -p "${APP_DIR}"
cd "${APP_DIR}"

echo "==> [DataScout] Configuring systemd background worker service..."

# 3. Create systemd service for EC2 background daemon
cat << 'EOF' > /etc/systemd/system/datascout-worker.service
[Unit]
Description=DataScout EC2 Background Dataset Worker
After=network.target

[Service]
Type=simple
User=ec2-user
WorkingDirectory=/opt/datascout
Environment=NODE_ENV=production
Environment=AWS_REGION=us-east-1
Restart=always
RestartSec=10
ExecStart=/usr/bin/node /opt/datascout/backend/dist/workers/ec2-dataset-worker.js

[Install]
WantedBy=multi-user.target
EOF

# 4. Enable service on boot
systemctl daemon-reload
echo "==> [DataScout] EC2 Worker bootstrap complete. Ready to start."
