#!/bin/bash

# Sanbot AWS Backend Setup Script
# Run this on EC2: chmod +x setup.sh && sudo ./setup.sh

set -e

DOMAIN="ai.tripandevent.com"
PORT="3051"

echo "=========================================="
echo "  Sanbot Backend Setup Script"
echo "=========================================="

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run with sudo: sudo ./setup.sh"
  exit 1
fi

# Create sites-available and sites-enabled directories if they don't exist
echo "[1/6] Creating Nginx directories..."
mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled

# Check if sites-enabled is included in nginx.conf
if ! grep -q "sites-enabled" /etc/nginx/nginx.conf; then
  echo "[*] Adding sites-enabled include to nginx.conf..."
  sed -i '/http {/a \    include /etc/nginx/sites-enabled/*;' /etc/nginx/nginx.conf
fi

# Create Nginx config for the domain
echo "[2/6] Creating Nginx config for $DOMAIN..."
cat > /etc/nginx/sites-available/$DOMAIN << 'NGINX_CONFIG'
server {
    listen 80;
    server_name ai.tripandevent.com;

    location / {
        proxy_pass http://localhost:3051;
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
NGINX_CONFIG

# Enable the site (create symlink)
echo "[3/6] Enabling the site..."
rm -f /etc/nginx/sites-enabled/$DOMAIN
ln -s /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN

# Test Nginx configuration
echo "[4/6] Testing Nginx configuration..."
nginx -t

# Reload Nginx
echo "[5/6] Reloading Nginx..."
systemctl reload nginx

# Install Certbot if not installed
echo "[6/6] Setting up SSL with Certbot..."
if ! command -v certbot &> /dev/null; then
  echo "Installing Certbot..."
  apt update
  apt install -y certbot python3-certbot-nginx
fi

# Get SSL certificate
echo "Getting SSL certificate for $DOMAIN..."
certbot --nginx -d $DOMAIN --non-interactive --agree-tos --email admin@$DOMAIN --redirect || {
  echo ""
  echo "SSL setup failed. You can run manually later:"
  echo "  sudo certbot --nginx -d $DOMAIN"
  echo ""
}

echo ""
echo "=========================================="
echo "  Setup Complete!"
echo "=========================================="
echo ""
echo "Test your endpoint:"
echo "  curl https://$DOMAIN/health"
echo ""
