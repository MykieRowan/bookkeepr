# BookKeepr

A web interface for managing your book acquisition pipeline. Search for books on Hardcover, automatically send them to Prowlarr for indexer searches, download via qBitTorrent, and organize with Calibre.

![BookKeepr Pipeline](https://img.shields.io/badge/Hardcover-Prowlarr-blue) ![Pipeline](https://img.shields.io/badge/Prowlarr-qBitTorrent-green) ![Final](https://img.shields.io/badge/qBitTorrent-Calibre-orange)

## Features

- 🔍 Search books using Hardcover's extensive database
- 📚 Automatically search indexers via Prowlarr
- ⬇️ Download books through qBitTorrent
- 📖 Organize with Calibre-Web
- 🐳 Fully Dockerized
- 🎨 Clean, modern web interface

## Prerequisites

- Docker and Docker Compose
- Running instances of:
  - Prowlarr
  - qBitTorrent
  - Calibre-Web (optional, for final organization)
- API keys for:
  - Hardcover
  - Prowlarr

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/yourusername/bookkeepr.git
cd bookkeepr
```

### 2. Configure Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:

```env
# Hardcover API Key (get from https://hardcover.app/settings/api)
HARDCOVER_API_KEY=your_hardcover_api_key_here

# Prowlarr Configuration
PROWLARR_URL=http://gluetun:9696
PROWLARR_API_KEY=your_prowlarr_api_key_here

# qBitTorrent Configuration
QBIT_URL=http://gluetun:8089
QBIT_USERNAME=admin
QBIT_PASSWORD=your_password_here

# Calibre Configuration
CALIBRE_INGEST_FOLDER=/mnt/Books/Calibre
```

### 3. Update docker-compose.yml

Edit `docker-compose.yml` to match your setup:

- Update the `volumes` path to your actual Calibre folder
- Update the `networks` section to match your Docker network name
- Adjust ports if needed

### 4. Deploy

#### Option A: Using Docker Compose (Command Line)

```bash
docker-compose up -d
```

#### Option B: Using Portainer

1. Go to **Stacks > Add Stack**
2. Choose **Git Repository**
3. Enter your repository URL
4. Set environment variables in Portainer's UI (don't commit your .env file!)
5. Click **Deploy the stack**

### 5. Access BookKeepr

Open your browser and navigate to:
```
http://your-server-ip:3000
```

## Configuration

### Getting API Keys

#### Hardcover API Key
1. Go to https://hardcover.app/settings/api
2. Create a new API key
3. Copy and add to your `.env` file

#### Prowlarr API Key
1. Open Prowlarr web interface
2. Go to **Settings > General**
3. Copy the API Key
4. Add to your `.env` file

### Network Configuration

BookKeepr needs to communicate with Prowlarr and qBitTorrent. Adjust the URLs based on your setup:

**If using Gluetun VPN container:**
```env
PROWLARR_URL=http://gluetun:9696
QBIT_URL=http://gluetun:8089
```

**If containers are directly accessible:**
```env
PROWLARR_URL=http://prowlarr:9696
QBIT_URL=http://qbittorrent:8080
```

**If using host networking:**
```env
PROWLARR_URL=http://localhost:9696
QBIT_URL=http://localhost:8080
```

### Docker Network

Update the `networks` section in `docker-compose.yml`:

```yaml
networks:
  internal:
    external: true  # Use existing network
    # name: your-network-name  # Uncomment and set if different from 'internal'
```

To find your network name:
```bash
docker network ls
```

## Project Structure

```
bookkeepr/
├── Dockerfile              # Container build instructions
├── docker-compose.yml      # Docker Compose configuration
├── server.js              # Backend Node.js server
├── package.json           # Node.js dependencies
├── .env.example           # Example environment variables
├── .gitignore            # Git ignore file
├── README.md             # This file
└── public/
    └── index.html        # Frontend web interface
```

## Usage

1. Open BookKeepr in your browser
2. Search for a book by title or author
3. Click **Download** on the desired result
4. BookKeepr will:
   - Send the request to Prowlarr
   - Prowlarr searches configured indexers
   - Best result is sent to qBitTorrent
   - qBitTorrent downloads the book

## Troubleshooting

### "Error connecting to server"
- Verify the container is running: `docker ps`
- Check logs: `docker logs bookkeepr`
- Ensure port 3000 is not already in use

### "Hardcover API error"
- Verify your `HARDCOVER_API_KEY` is correct
- Check the API key is active at https://hardcover.app/settings/api

### "No results found in indexers"
- Verify `PROWLARR_URL` and `PROWLARR_API_KEY` are correct
- Ensure Prowlarr is on the same Docker network
- Check that indexers are configured in Prowlarr

### "Downloads not starting"
- Verify Prowlarr is connected to qBitTorrent (Settings > Download Clients)
- Check qBitTorrent credentials are correct
- Ensure containers can communicate (check Docker networks)

### Container name resolution issues
If `http://gluetun:9696` doesn't work:
- Run `docker ps` to see actual container names
- Update URLs in `.env` to match actual names
- Verify all containers are on the same network

## Calibre Integration

Currently, BookKeepr sends books to qBitTorrent. To automatically import completed downloads into Calibre:

### Option 1: qBitTorrent Auto-Copy
1. In qBitTorrent, go to **Tools > Options > Downloads**
2. Enable "Copy .torrent files for finished downloads to"
3. Set path to your Calibre ingest folder

### Option 2: File Watcher Script
A file watcher script can be added to automatically move completed downloads. This feature is planned for a future release.

## Development

### Local Development (Without Docker)

1. Install Node.js (v18 or later)
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set environment variables:
   ```bash
   export HARDCOVER_API_KEY=your_key
   export PROWLARR_URL=http://localhost:9696
   # ... etc
   ```
4. Start the server:
   ```bash
   node server.js
   ```
5. Open http://localhost:3000

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - See LICENSE file for details

## Acknowledgments

- [Hardcover](https://hardcover.app) - Book database and API
- [Prowlarr](https://prowlarr.com) - Indexer management
- [qBitTorrent](https://www.qbittorrent.org) - Torrent client
- [Calibre](https://calibre-ebook.com) - E-book management

## Support

If you encounter issues:
1. Check the [Troubleshooting](#troubleshooting) section
2. Review container logs: `docker logs bookkeepr`
3. Open an issue on GitHub with:
   - Your docker-compose.yml (remove sensitive data)
   - Container logs
   - Steps to reproduce the issue
