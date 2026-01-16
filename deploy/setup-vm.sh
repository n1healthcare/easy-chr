#!/bin/bash

# N1 Healthcare - VM Setup Script
# Run this on a fresh Ubuntu 24.04 VM
# Usage: curl -sSL <url> | bash

set -e

echo "🏥 N1 Healthcare - VM Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Update system
echo "📦 Updating system..."
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
echo "📦 Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 (process manager)
echo "📦 Installing PM2..."
sudo npm install -g pm2

# Install nginx
echo "📦 Installing nginx..."
sudo apt install -y nginx

# Create app directory
echo "📁 Setting up app directory..."
sudo mkdir -p /var/www/n1healthcare
sudo chown $USER:$USER /var/www/n1healthcare

# Clone repository (user needs to update this URL)
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📥 Clone your repository:"
echo "   cd /var/www/n1healthcare"
echo "   git clone <YOUR_REPO_URL> ."
echo ""
echo "   Or copy files with scp:"
echo "   scp -r ./* user@your-vm-ip:/var/www/n1healthcare/"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "✅ Base setup complete!"
echo ""
echo "Next steps:"
echo "1. Copy your code to /var/www/n1healthcare"
echo "2. Run: cd /var/www/n1healthcare && ./deploy/install-app.sh"
