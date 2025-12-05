const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files (for the frontend)
app.use(express.static('public'));

// Configuration - reads from environment variables
const CONFIG = {
  hardcover: {
    apiKey: process.env.HARDCOVER_API_KEY || 'YOUR_HARDCOVER_API_KEY'
  },
  mam: {
    id: process.env.MAM_ID || null
  },
  prowlarr: {
    url: process.env.PROWLARR_URL || 'http://localhost:9696',
    apiKey: process.env.PROWLARR_API_KEY || 'YOUR_PROWLARR_API_KEY'
  },
  qbittorrent: {
    url: process.env.QBIT_URL || 'http://localhost:8080',
    username: process.env.QBIT_USERNAME || 'admin',
    password: process.env.QBIT_PASSWORD || 'adminadmin'
  },
  calibre: {
    ingestFolder: process.env.CALIBRE_INGEST_FOLDER || '/calibre/ingest'
  }
};

// qBittorrent session cookie storage
let qbitCookie = null;

// Login to qBittorrent and get session cookie
async function loginToQBittorrent() {
  try {
    console.log('Logging into qBittorrent...');
    const FormData = require('form-data');
    const form = new FormData();
    form.append('username', CONFIG.qbittorrent.username);
    form.append('password', CONFIG.qbittorrent.password);

    const response = await axios.post(
      `${CONFIG.qbittorrent.url}/api/v2/auth/login`,
      form,
      {
        headers: form.getHeaders(),
        maxRedirects: 0,
        validateStatus: (status) => status === 200
      }
    );

    const cookies = response.headers['set-cookie'];
    if (cookies && cookies.length > 0) {
      qbitCookie = cookies[0].split(';')[0];
      console.log('✓ qBittorrent login successful');
      return true;
    }

    console.log('✓ qBittorrent login successful (no cookie needed)');
    return true;
  } catch (error) {
    console.error('qBittorrent login error:', error.message);
    return false;
  }
}

// Add torrent to qBittorrent
async function addTorrentToQBittorrent(downloadUrl, title) {
  try {
    if (!qbitCookie) {
      await loginToQBittorrent();
    }

    console.log(`Adding torrent to qBittorrent: ${title}`);
    
    const FormData = require('form-data');
    const form = new FormData();
    form.append('urls', downloadUrl);
    form.append('savepath', CONFIG.calibre.ingestFolder);

    const headers = { ...form.getHeaders() };
    if (qbitCookie) {
      headers['Cookie'] = qbitCookie;
    }

    await axios.post(
      `${CONFIG.qbittorrent.url}/api/v2/torrents/add`,
      form,
      { headers, timeout: 10000 }
    );

    console.log('✓ Torrent added to qBittorrent');
    return true;
  } catch (error) {
    console.error('qBittorrent add error:', error.message);
    
    if (error.response && error.response.status === 403) {
      console.log('Session expired, re-logging in...');
      qbitCookie = null;
      await loginToQBittorrent();
      return addTorrentToQBittorrent(downloadUrl, title);
    }
    
    return false;
  }
}

// Search MyAnonaMouse
async function searchMAM(title) {
  if (!CONFIG.mam.id) {
    console.log('MAM not configured, skipping');
    return null;
  }

  try {
    console.log(`Searching MAM for: ${title}`);

    const response = await axios.post(
      'https://www.myanonamouse.net/tor/js/loadSearchJSONbasic.php',
      {
        tor: {
          text: title,
          srchIn: ['title'],
          searchType: 'all',
          searchIn: 'torrents',
          cat: ['0'],
          main_cat: [14],
          sortType: 'default',
          startNumber: '0'
        }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Cookie': `mam_id=${CONFIG.mam.id}`
        },
        timeout: 10000
      }
    );

    if (response.data && response.data.data && response.data.data.length > 0) {
      console.log(`MAM found ${response.data.data.length} results`);
      return response.data.data[0];
    }

    console.log('No results from MAM');
    return null;
  } catch (error) {
    console.error('MAM search error:', error.message);
    return null;
  }
}

// Download from MAM
async function downloadFromMAM(mamResult) {
  try {
    console.log(`Downloading MAM torrent: ${mamResult.title}`);
    
    const torrentUrl = `https://www.myanonamouse.net/tor/download.php/${mamResult.dl}`;
    
    const torrentResponse = await axios.get(torrentUrl, {
      headers: { 'Cookie': `mam_id=${CONFIG.mam.id}` },
      responseType: 'arraybuffer',
      timeout: 10000
    });

    if (!qbitCookie) {
      await loginToQBittorrent();
    }

    const FormData = require('form-data');
    const form = new FormData();
    form.append('torrents', Buffer.from(torrentResponse.data), {
      filename: `${mamResult.id}.torrent`,
      contentType: 'application/x-bittorrent'
    });
    form.append('savepath', CONFIG.calibre.ingestFolder);

    const headers = { ...form.getHeaders() };
    if (qbitCookie) {
      headers['Cookie'] = qbitCookie;
    }

    await axios.post(
      `${CONFIG.qbittorrent.url}/api/v2/torrents/add`,
      form,
      { headers, timeout: 10000 }
    );

    console.log('✓ MAM torrent added to qBittorrent');
    return true;
  } catch (error) {
    console.error('MAM download error:', error.message);
    return false;
  }
}

// Search Prowlarr
async function searchProwlarr(title, author, isbn) {
  try {
    let searchQuery = title;
    if (author && author !== 'Unknown') {
      searchQuery += ` ${author}`;
    }

    console.log(`Searching Prowlarr for: ${searchQuery}`);

    const response = await axios.get(`${CONFIG.prowlarr.url}/api/v1/search`, {
      params: { query: searchQuery, type: 'book', limit: 50 },
      headers: { 'X-Api-Key': CONFIG.prowlarr.apiKey },
      timeout: 30000
    });

    console.log(`Found ${response.data.length} results in Prowlarr`);
    return response.data;
  } catch (error) {
    console.error('Prowlarr search error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

// API Routes
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ success: false, error: 'Search query is required' });
    }

    console.log(`Searching Hardcover for: ${query}`);

    const response = await axios.post(
      'https://api.hardcover.app/v1/graphql',
      {
        query: `
          query SearchBooks($query: String!) {
            search(query: $query, query_type: "Book", per_page: 20) {
              results
            }
          }
        `,
        variables: { query }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.hardcover.apiKey}`
        },
        timeout: 10000
      }
    );

    if (response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
      return res.status(500).json({ success: false, error: 'Hardcover API error' });
    }

    const searchResults = response.data.data?.search?.results || {};
    const hits = searchResults.hits || [];
    const books = hits.map(hit => hit.document);

    res.json({ success: true, books });
  } catch (error) {
    console.error('Hardcover search error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/download', async (req, res) => {
  try {
    const { title, author, isbn, year } = req.body;

    if (!title) {
      return res.status(400).json({ success: false, error: 'Book title is required' });
    }

    console.log('\n=== New Download Request ===');
    console.log(`Title: ${title}`);
    console.log(`Author: ${author}`);
    console.log(`ISBN: ${isbn}`);
    console.log(`Year: ${year}`);

    // Try MAM first if configured
    if (CONFIG.mam.id) {
      console.log('Trying MAM direct search...');
      const mamResult = await searchMAM(title);
      
      if (mamResult) {
        const downloaded = await downloadFromMAM(mamResult);
        
        if (downloaded) {
          return res.json({
            success: true,
            message: 'Download started via MAM',
            source: 'mam',
            details: {
              title: mamResult.title,
              size: mamResult.size,
              seeders: mamResult.seeders
            }
          });
        }
      }
      
      console.log('MAM search failed or no results, falling back to Prowlarr...');
    }

    // Fall back to Prowlarr
    const results = await searchProwlarr(title, author, isbn);

    if (!results || results.length === 0) {
      return res.json({ success: false, error: 'No results found in indexers' });
    }

    // Filter and sort results
    const sortedResults = results
      .filter(r => {
        if (!r.title || !r.guid) return false;
        const title = r.title.toLowerCase();
        if (title.includes('audiobook') || title.includes('audio book') || 
            title.includes('.m4b') || title.includes('.mp3')) {
          return false;
        }
        return title.includes('epub') || title.includes('mobi') || 
               title.includes('pdf') || title.includes('azw') || title.includes('azw3');
      })
      .sort((a, b) => {
        const aIsEpub = /epub/i.test(a.title);
        const bIsEpub = /epub/i.test(b.title);
        
        if (aIsEpub && !bIsEpub) return -1;
        if (!aIsEpub && bIsEpub) return 1;
        
        return (b.seeders || 0) - (a.seeders || 0);
      });

    if (sortedResults.length === 0) {
      return res.json({ success: false, error: 'No ebook results found (only audiobooks available)' });
    }

    const bestResult = sortedResults[0];
    console.log(`Selected: ${bestResult.title}`);
    console.log(`  Size: ${(bestResult.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Seeders: ${bestResult.seeders || '?'}`);
    console.log(`  Indexer: ${bestResult.indexer}`);
    
    console.log(`\nDEBUG - Full result:`, JSON.stringify(bestResult, null, 2));

    const downloadUrl = bestResult.downloadUrl || bestResult.magnetUrl;
    
    if (!downloadUrl) {
      console.error('No download URL found in result');
      return res.json({ success: false, error: 'No download link available' });
    }

    console.log(`Download URL: ${downloadUrl.substring(0, 50)}...`);

    const added = await addTorrentToQBittorrent(downloadUrl, bestResult.title);

    if (!added) {
      return res.json({ success: false, error: 'Failed to add torrent to qBittorrent' });
    }

    res.json({
      success: true,
      message: 'Download started successfully',
      source: 'prowlarr',
      details: {
        title: bestResult.title,
        size: `${(bestResult.size / 1024 / 1024).toFixed(2)} MB`,
        indexer: bestResult.indexer,
        seeders: bestResult.seeders
      }
    });
  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    config: {
      hardcover: CONFIG.hardcover.apiKey ? 'API key set' : 'API key missing',
      mam: CONFIG.mam.id ? 'Cookie set' : 'Not configured',
      prowlarr: CONFIG.prowlarr.url,
      qbittorrent: CONFIG.qbittorrent.url,
      calibre: CONFIG.calibre.ingestFolder
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📚 Liberry Server running on http://0.0.0.0:${PORT}`);
  console.log(`\n⚙️  Configuration:`);
  console.log(`   Hardcover: ${CONFIG.hardcover.apiKey ? '✓ API key set' : '✗ API key missing'}`);
  console.log(`   MAM: ${CONFIG.mam.id ? '✓ Cookie set (trying MAM first)' : '✗ Not configured (Prowlarr only)'}`);
  console.log(`   Prowlarr: ${CONFIG.prowlarr.url}`);
  console.log(`   qBitTorrent: ${CONFIG.qbittorrent.url}`);
  console.log(`   Calibre: ${CONFIG.calibre.ingestFolder}`);
  console.log(`\n📝 Make sure to set environment variables!`);
  
  loginToQBittorrent();
});
