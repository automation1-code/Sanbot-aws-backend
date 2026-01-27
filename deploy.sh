#!/bin/bash

# Sanbot Full Deploy Script (Node.js + Python Agent)
# Usage: chmod +x deploy.sh && sudo ./deploy.sh

set -e

echo "=========================================="
echo "  Sanbot Full Deploy"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run with sudo: sudo ./deploy.sh"
  exit 1
fi

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
AGENT_DIR="$PROJECT_DIR/agent"
DEPLOY_USER="${SUDO_USER:-ubuntu}"

echo "Project dir: $PROJECT_DIR"
echo "Deploy user: $DEPLOY_USER"
echo ""

# === STEP 1: Check .env exists ===
echo "[1/8] Checking .env file..."
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "ERROR: .env file not found!"
  echo "Create .env with at minimum:"
  echo "  OPENAI_API_KEY=sk-proj-..."
  echo "  PORT=3051"
  exit 1
fi

# Check required keys
if ! grep -q "OPENAI_API_KEY=" "$PROJECT_DIR/.env"; then
  echo "ERROR: OPENAI_API_KEY not found in .env"
  exit 1
fi
echo "  .env found with OPENAI_API_KEY"

# Check optional keys and warn
if ! grep -q "LIVEKIT_URL=" "$PROJECT_DIR/.env"; then
  echo "  WARNING: LIVEKIT_URL not in .env - Python agent will NOT start"
  echo "  WARNING: Add LiveKit keys to .env if you want the Python agent"
  SKIP_PYTHON=true
else
  SKIP_PYTHON=false
fi

# === STEP 2: Install system dependencies ===
echo ""
echo "[2/8] Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq python3 python3-pip python3-venv curl > /dev/null 2>&1

# Install Node.js if not present
if ! command -v node &> /dev/null; then
  echo "  Installing Node.js..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null 2>&1
fi
echo "  Node: $(node --version)"
echo "  Python: $(python3 --version)"

# Install PM2 if not present
if ! command -v pm2 &> /dev/null; then
  echo "  Installing PM2..."
  npm install -g pm2 > /dev/null 2>&1
fi
echo "  PM2: $(pm2 --version)"

# === STEP 3: Install Node.js dependencies ===
echo ""
echo "[3/8] Installing Node.js dependencies..."
cd "$PROJECT_DIR"
sudo -u "$DEPLOY_USER" npm install --omit=dev 2>&1 | tail -1
echo "  Node.js dependencies installed"

# === STEP 4: Setup Python virtual environment ===
echo ""
echo "[4/8] Setting up Python environment..."
if [ ! -d "$AGENT_DIR/venv" ]; then
  echo "  Creating virtual environment..."
  sudo -u "$DEPLOY_USER" python3 -m venv "$AGENT_DIR/venv"
fi
echo "  Installing Python dependencies..."
sudo -u "$DEPLOY_USER" "$AGENT_DIR/venv/bin/pip" install -q -r "$AGENT_DIR/requirements.txt" 2>&1 | tail -3
echo "  Python dependencies installed"

# === STEP 5: Setup Nginx (if not already configured) ===
echo ""
echo "[5/8] Checking Nginx..."
DOMAIN="ai.tripandevent.com"

if command -v nginx &> /dev/null; then
  # Check if our site config exists
  if [ ! -f "/etc/nginx/sites-available/sanbot-backend" ]; then
    echo "  Creating Nginx config for $DOMAIN..."
    mkdir -p /etc/nginx/sites-available /etc/nginx/sites-enabled

    cat > /etc/nginx/sites-available/sanbot-backend << 'NGINX_EOF'
server {
    listen 80;
    server_name ai.tripandevent.com;

    location / {
        proxy_pass http://127.0.0.1:3051;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 75s;
    }
}
NGINX_EOF

    ln -sf /etc/nginx/sites-available/sanbot-backend /etc/nginx/sites-enabled/
    nginx -t && systemctl reload nginx
    echo "  Nginx configured"

    # SSL with Certbot
    if command -v certbot &> /dev/null; then
      echo "  Setting up SSL..."
      certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --email admin@"$DOMAIN" --redirect 2>&1 | tail -3
    fi
  else
    echo "  Nginx already configured"
  fi

  # Ensure port 443 is open
  if command -v ufw &> /dev/null; then
    ufw allow 443 > /dev/null 2>&1
    ufw allow 80 > /dev/null 2>&1
  fi
else
  echo "  Nginx not installed - skipping (use: apt install nginx)"
fi

# === STEP 6: Deploy Node.js Backend ===
echo ""
echo "[6/8] Deploying Node.js backend..."
cd "$PROJECT_DIR"

# Stop existing process (don't fail if not found)
sudo -u "$DEPLOY_USER" pm2 delete sanbot-backend 2>/dev/null || true

# Start Node.js backend
sudo -u "$DEPLOY_USER" pm2 start server.js --name sanbot-backend
echo "  Node.js backend started"

# Wait and verify
sleep 2
NODE_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3051/health 2>/dev/null || echo "000")
if [ "$NODE_HEALTH" = "200" ]; then
  echo "  Health check: OK"
else
  echo "  WARNING: Health check returned $NODE_HEALTH"
  echo "  Check logs: pm2 logs sanbot-backend"
fi

# === STEP 7: Deploy Python Agent (systemd) ===
echo ""
echo "[7/8] Deploying Python agent..."

if [ "$SKIP_PYTHON" = true ]; then
  echo "  SKIPPED - LiveKit keys not configured in .env"
  echo "  Add LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET to .env"
  echo "  Then run: sudo ./deploy.sh"
else
  # Create systemd service file
  cat > /etc/systemd/system/sanbot-agent.service << SYSTEMD_EOF
[Unit]
Description=Sanbot Python Agent
After=network.target

[Service]
Type=simple
User=$DEPLOY_USER
WorkingDirectory=$AGENT_DIR
ExecStart=$AGENT_DIR/venv/bin/python3 agent.py start
Restart=always
RestartSec=5
EnvironmentFile=$PROJECT_DIR/.env

[Install]
WantedBy=multi-user.target
SYSTEMD_EOF

  systemctl daemon-reload
  systemctl enable sanbot-agent
  systemctl restart sanbot-agent
  echo "  Python agent started (systemd)"

  # Wait and check
  sleep 3
  if systemctl is-active --quiet sanbot-agent; then
    echo "  Agent status: running"
  else
    echo "  WARNING: Agent may have failed. Check: journalctl -u sanbot-agent"
  fi
fi

# === STEP 8: Save PM2 config ===
echo ""
echo "[8/8] Saving PM2 configuration..."
sudo -u "$DEPLOY_USER" pm2 save
# Setup PM2 to restart on boot
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$DEPLOY_USER" --hp "/home/$DEPLOY_USER" > /dev/null 2>&1 || true
echo "  PM2 config saved (auto-restart on reboot)"

# === DONE ===
echo ""
echo "=========================================="
echo "  Deploy Complete!"
echo "=========================================="
echo ""
sudo -u "$DEPLOY_USER" pm2 status
echo ""
echo "Python agent:"
systemctl is-active sanbot-agent 2>/dev/null && echo "  sanbot-agent: running" || echo "  sanbot-agent: not running"
echo ""
echo "Test endpoints:"
echo "  curl http://localhost:3051/health"
echo "  curl https://$DOMAIN/health"
echo ""
echo "View logs:"
echo "  pm2 logs sanbot-backend"
echo "  sudo journalctl -u sanbot-agent -f"
echo ""
