#!/bin/bash

# N1 Healthcare - App Installation Script
# Run this after copying code to /var/www/n1healthcare

set -e

APP_DIR="/var/www/n1healthcare"
cd $APP_DIR

echo "🏥 N1 Healthcare - App Installation"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Install server dependencies
echo "📦 Installing server dependencies..."
cd $APP_DIR/server
npm install

# Create .env if it doesn't exist
if [ ! -f .env ]; then
    echo ""
    echo "⚠️  No .env file found!"
    echo "   Create one with your API keys:"
    echo ""
    echo "   nano $APP_DIR/server/.env"
    echo ""
    echo "   Required variables:"
    echo "   GEMINI_API_KEY=your-key-here"
    echo "   GOOGLE_GEMINI_BASE_URL=your-litellm-url (optional)"
    echo ""
    read -p "Press Enter after creating .env..."
fi

# Build server
echo "🔨 Building server..."
npm run build

# Install client dependencies and build
echo "📦 Installing client dependencies..."
cd $APP_DIR/client
npm install

echo "🔨 Building client..."
npm run build

# Setup nginx
echo "🌐 Configuring nginx..."
sudo tee /etc/nginx/sites-available/n1healthcare > /dev/null <<'EOF'
server {
    listen 80;
    server_name _;

    # Serve client static files
    root /var/www/n1healthcare/client/dist;
    index index.html;

    # Client routes (SPA)
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API proxy to Node server
    location /api {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
        proxy_read_timeout 300s;
        proxy_connect_timeout 300s;
        client_max_body_size 500M;
    }

    # Serve generated realms
    location /realms {
        alias /var/www/n1healthcare/server/storage/realms;
        try_files $uri $uri/ =404;
    }
}
EOF

# Enable site
sudo ln -sf /etc/nginx/sites-available/n1healthcare /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx

# Start server with PM2
echo "🚀 Starting server with PM2..."
cd $APP_DIR/server
pm2 delete n1-server 2>/dev/null || true
pm2 start npm --name "n1-server" -- run start
pm2 save
pm2 startup | tail -1 | sudo bash

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Installation complete!"
echo ""
echo "🌐 Your app is now running at:"
echo "   http://$(curl -s ifconfig.me)"
echo ""
echo "📊 Useful commands:"
echo "   pm2 status        - Check server status"
echo "   pm2 logs          - View server logs"
echo "   pm2 restart all   - Restart server"
echo ""
echo "🔒 Next: Set up SSL with:"
echo "   sudo apt install certbot python3-certbot-nginx"
echo "   sudo certbot --nginx -d yourdomain.com"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
