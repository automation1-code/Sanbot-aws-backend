# Sanbot AI Backend - EC2 Deployment

## API Endpoints

| Method | Endpoint | Description |
|------|---------|-------------|
| GET  | /health  | Health check (returns OK) |
| GET  | /token   | Generate ephemeral realtime token |
| POST | /session | Create OpenAI Realtime SDP session |

---

## Server Info

- Node.js: 18+
- Process Manager: PM2
- Port: 3051
- Type: Backend-only (no frontend)

---

## Quick Update (Already Deployed)

```bash
# SSH into EC2
ssh -i your-key.pem ubuntu@YOUR_EC2_IP

# Pull latest code
cd ~/Sanbot-aws-backend
git pull origin main

# Install dependencies
npm install

# Restart server
pm2 restart sanbot-backend
