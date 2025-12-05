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
    ingestFolder: process.env.CALIBRE_INGEST_FOLDER || '/calibre/ingest',
    url: process.env.CALIBRE_URL && process.env.CALIBRE_URL !== 'disabled' ? process.env.CALIBRE_URL : null,
    username: process.env.CALIBRE_USERNAME || null,
    password: process.env.CALIBRE_PASSWORD || null
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
async function addTorrentToQBittorrent(downloadUrl, title, viaProwlarr = false) {
  try {
    if (!qbitCookie) {
      await loginToQBittorrent();
    }

    console.log(`\nAdding torrent to qBittorrent:`);
    console.log(`  Title: ${title}`);
    console.log(`  Download URL: ${downloadUrl}`);
    console.log(`  Via Prowlarr: ${viaProwlarr}`);
    
    const FormData = require('form-data');
    const form = new FormData();
    
    // If it's from Prowlarr, download the torrent file first
    if (viaProwlarr && downloadUrl.startsWith('http')) {
      console.log(`  Downloading torrent file through Prowlarr...`);
      try {
        const torrentResponse = await axios.get(downloadUrl, {
          responseType: 'arraybuffer',
          timeout: 10000,
          headers: {
            'X-Api-Key': CONFIG.prowlarr.apiKey
          }
        });
        
        console.log(`  Got torrent file, size: ${torrentResponse.data.length} bytes`);
        
        // Send the actual torrent file to qBittorrent
        form.append('torrents', Buffer.from(torrentResponse.data), {
          filename: 'download.torrent',
          contentType: 'application/x-bittorrent'
        });
      } catch (downloadError) {
        console.error(`  Failed to download torrent file: ${downloadError.message}`);
        // Fall back to URL method
        form.append('urls', downloadUrl);
      }
    } else {
      // Use URL directly (for magnets or direct URLs)
      form.append('urls', downloadUrl);
    }
    
    form.append('savepath', CONFIG.calibre.ingestFolder);

    const headers = { ...form.getHeaders() };
    if (qbitCookie) {
      headers['Cookie'] = qbitCookie;
    }

    console.log(`  Sending to: ${CONFIG.qbittorrent.url}/api/v2/torrents/add`);
    
    const response = await axios.post(
      `${CONFIG.qbittorrent.url}/api/v2/torrents/add`,
      form,
      { headers, timeout: 10000 }
    );

    console.log(`  qBittorrent response status: ${response.status}`);
    console.log(`  qBittorrent response data: ${response.data}`);
    console.log('✓ Torrent added to qBittorrent successfully');
    return true;
  } catch (error) {
    console.error('qBittorrent add error:', error.message);
    if (error.response) {
      console.error('  Response status:', error.response.status);
      console.error('  Response data:', error.response.data);
    }
    
    if (error.response && error.response.status === 403) {
      console.log('Session expired, re-logging in...');
      qbitCookie = null;
      await loginToQBittorrent();
      return addTorrentToQBittorrent(downloadUrl, title, viaProwlarr);
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
    console.log(`\nDownloading MAM torrent:`);
    console.log(`  Title: ${mamResult.title}`);
    console.log(`  ID: ${mamResult.id}`);
    console.log(`  DL: ${mamResult.dl}`);
    
    const torrentUrl = `https://www.myanonamouse.net/tor/download.php/${mamResult.dl}`;
    console.log(`  Torrent URL: ${torrentUrl}`);
    
    const torrentResponse = await axios.get(torrentUrl, {
      headers: { 
        'Cookie': `mam_id=${CONFIG.mam.id}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      responseType: 'arraybuffer',
      timeout: 10000
    });

    console.log(`  Downloaded torrent file, size: ${torrentResponse.data.length} bytes`);
    console.log(`  Content-Type: ${torrentResponse.headers['content-type']}`);

    // Check if we actually got a torrent file
    if (torrentResponse.headers['content-type'] && 
        !torrentResponse.headers['content-type'].includes('bittorrent') &&
        !torrentResponse.headers['content-type'].includes('octet-stream')) {
      console.error(`  ERROR: Did not receive a torrent file!`);
      console.error(`  Received content type: ${torrentResponse.headers['content-type']}`);
      console.error(`  First 200 chars of response: ${Buffer.from(torrentResponse.data).toString('utf8', 0, 200)}`);
      return false;
    }

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

    console.log(`  Sending to qBittorrent...`);
    
    const qbitResponse = await axios.post(
      `${CONFIG.qbittorrent.url}/api/v2/torrents/add`,
      form,
      { headers, timeout: 10000 }
    );

    console.log(`  qBittorrent response: ${qbitResponse.status} - ${qbitResponse.data}`);
    console.log('✓ MAM torrent added to qBittorrent successfully');
    return true;
  } catch (error) {
    console.error('MAM download error:', error.message);
    if (error.response) {
      console.error('  Response status:', error.response.status);
      console.error('  Response headers:', error.response.headers);
      if (error.response.data) {
        const dataPreview = Buffer.isBuffer(error.response.data) 
          ? error.response.data.toString('utf8', 0, 200)
          : JSON.stringify(error.response.data).substring(0, 200);
        console.error('  Response data preview:', dataPreview);
      }
    }
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

// Check if book exists in Calibre library
async function checkCalibreForBook(title, author, isbn) {
  if (!CONFIG.calibre.url) {
    return { inLibrary: false, reason: 'Calibre not configured' };
  }

  try {
    const auth = CONFIG.calibre.username && CONFIG.calibre.password 
      ? { username: CONFIG.calibre.username, password: CONFIG.calibre.password }
      : undefined;

    // Try ISBN search first (most accurate)
    if (isbn) {
      try {
        console.log(`Checking Calibre for ISBN: ${isbn}`);
        
        const response = await axios.get(`${CONFIG.calibre.url}/ajax/books`, {
          params: { 
            search: `identifiers:=${isbn}`,
            num: 10
          },
          auth,
          timeout: 5000
        });

        if (response.data && response.data.total_num > 0) {
          console.log(`✓ Found by ISBN: ${response.data.total_num} matches`);
          return { 
            inLibrary: true, 
            count: response.data.total_num
          };
        }
      } catch (isbnError) {
        console.log(`ISBN search failed: ${isbnError.message}`);
      }
    }

    // Try exact title match
    if (title) {
      console.log(`Checking Calibre for exact title: ${title}`);
      
      try {
        const response = await axios.get(`${CONFIG.calibre.url}/ajax/books`, {
          params: { 
            search: `title:"=${title}"`,
            num: 10
          },
          auth,
          timeout: 5000
        });

        if (response.data && response.data.total_num > 0) {
          console.log(`✓ Found by exact title: ${response.data.total_num} matches`);
          return { 
            inLibrary: true,
            count: response.data.total_num
          };
        }
      } catch (exactError) {
        console.log(`Exact title search failed: ${exactError.message}`);
      }
    }

    // Try fuzzy title match (most generous)
    if (title) {
      // Remove special characters and extra spaces
      const cleanTitle = title
        .replace(/[:\(\)\[\]—–\-""'']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      console.log(`Checking Calibre for fuzzy title: ${cleanTitle}`);
      
      try {
        const response = await axios.get(`${CONFIG.calibre.url}/ajax/books`, {
          params: { 
            search: `title:"~${cleanTitle}"`,
            num: 20
          },
          auth,
          timeout: 5000
        });

        if (response.data && response.data.total_num > 0) {
          console.log(`✓ Found by fuzzy title: ${response.data.total_num} matches`);
          return { 
            inLibrary: true,
            count: response.data.total_num
          };
        }
      } catch (fuzzyError) {
        console.log(`Fuzzy title search failed: ${fuzzyError.message}`);
      }
    }

    // Last resort - search just the main words from title
    if (title) {
      const mainWords = title
        .replace(/[:\(\)\[\]—–\-""'']/g, ' ')
        .split(' ')
        .filter(word => word.length > 3) // Only words longer than 3 chars
        .slice(0, 3) // Take first 3 significant words
        .join(' ');
      
      if (mainWords) {
        console.log(`Checking Calibre for main words: ${mainWords}`);
        
        try {
          const response = await axios.get(`${CONFIG.calibre.url}/ajax/books`, {
            params: { 
              search: mainWords,
              num: 20
            },
            auth,
            timeout: 5000
          });

          if (response.data && response.data.total_num > 0) {
            console.log(`✓ Found by keywords: ${response.data.total_num} matches`);
            return { 
              inLibrary: true,
              count: response.data.total_num
            };
          }
        } catch (keywordError) {
          console.log(`Keyword search failed: ${keywordError.message}`);
        }
      }
    }

    console.log('Book not found in Calibre');
    return { inLibrary: false };
  } catch (error) {
    console.error('Calibre check error:', error.message);
    if (error.response) {
      console.error('  Status:', error.response.status);
      console.error('  Data:', JSON.stringify(error.response.data).substring(0, 200));
    }
    return { inLibrary: false, error: error.message };
  }
}

// List all books in Calibre library (for debugging)
async function listCalibreLibrary() {
  if (!CONFIG.calibre.url) {
    console.log('Calibre not configured, skipping library list');
    return;
  }

  try {
    console.log('\n📚 Fetching Calibre library contents...');
    
    const auth = CONFIG.calibre.username && CONFIG.calibre.password 
      ? { username: CONFIG.calibre.username, password: CONFIG.calibre.password }
      : undefined;

    const response = await axios.get(`${CONFIG.calibre.url}/ajax/books`, {
      params: { 
        num: 100,  // Get up to 100 books
        sort: 'title'
      },
      auth,
      timeout: 10000
    });

    if (response.data && response.data.total_num > 0) {
      console.log(`\n✓ Found ${response.data.total_num} books in Calibre library:\n`);
      
      response.data.books.forEach((book, index) => {
        const authors = book.authors ? book.authors.join(', ') : 'Unknown';
        const identifiers = book.identifiers ? Object.entries(book.identifiers).map(([type, id]) => `${type}:${id}`).join(', ') : 'none';
        console.log(`${index + 1}. "${book.title}" by ${authors}`);
        console.log(`   ID: ${book.id} | Identifiers: ${identifiers}`);
      });
      
      console.log(`\nTotal: ${response.data.total_num} books\n`);
    } else {
      console.log('⚠️  Calibre library appears to be empty or not accessible');
    }
  } catch (error) {
    console.error('Failed to list Calibre library:', error.message);
    if (error.response) {
      console.error('  Status:', error.response.status);
      console.error('  URL:', error.config?.url);
    }
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

// New endpoint to check if books are in Calibre
app.post('/api/check-calibre', async (req, res) => {
  try {
    const { books } = req.body;

    console.log('\n=== Calibre Check Request ===');
    console.log(`Checking ${books?.length || 0} books`);
    console.log(`Calibre URL configured: ${CONFIG.calibre.url || 'NOT SET'}`);

    if (!books || !Array.isArray(books)) {
      return res.status(400).json({ success: false, error: 'Books array required' });
    }

    if (!CONFIG.calibre.url) {
      console.log('Calibre URL not configured, skipping checks');
      return res.json({ success: true, results: {} });
    }

    // Check each book in parallel
    const checks = await Promise.all(
      books.map(async (book) => {
        console.log(`Checking: ${book.title} (ID: ${book.id})`);
        const result = await checkCalibreForBook(
          book.title,
          book.author_names?.[0] || book.author,
          book.isbn_13 || book.isbn_10
        );
        console.log(`  Result: ${result.inLibrary ? 'IN LIBRARY' : 'not found'}`);
        return { id: book.id, ...result };
      })
    );

    // Convert to object keyed by book ID
    const results = {};
    checks.forEach(check => {
      results[check.id] = check.inLibrary;
    });

    console.log(`Calibre check complete. Found ${Object.values(results).filter(Boolean).length} books in library`);
    res.json({ success: true, results });
  } catch (error) {
    console.error('Calibre check error:', error.message);
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

    // Try MAM first if configured (set MAM_ID to empty or remove to disable)
    if (CONFIG.mam.id && CONFIG.mam.id !== 'disabled') {
      console.log('Trying MAM direct search...');
      const mamResult = await searchMAM(title);
      
      if (mamResult) {
        console.log('MAM found result, attempting download...');
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
        } else {
          console.log('MAM download failed, falling back to Prowlarr...');
        }
      } else {
        console.log('MAM search found no results, falling back to Prowlarr...');
      }
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
      mam: CONFIG.mam.id && CONFIG.mam.id !== 'disabled' ? 'Cookie set (disabled for now)' : 'Not configured',
      prowlarr: CONFIG.prowlarr.url,
      qbittorrent: CONFIG.qbittorrent.url,
      calibre: {
        ingestFolder: CONFIG.calibre.ingestFolder,
        url: CONFIG.calibre.url || 'Not configured',
        checking: CONFIG.calibre.url ? 'Enabled' : 'Disabled'
      }
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
  console.log(`   MAM: ${CONFIG.mam.id && CONFIG.mam.id !== 'disabled' ? '✓ Cookie set (disabled)' : '✗ Not configured'}`);
  console.log(`   Prowlarr: ${CONFIG.prowlarr.url}`);
  console.log(`   qBitTorrent: ${CONFIG.qbittorrent.url}`);
  console.log(`   Calibre Ingest: ${CONFIG.calibre.ingestFolder}`);
  console.log(`   Calibre Web: ${CONFIG.calibre.url || '✗ Not configured (library checking disabled)'}`);
  if (CONFIG.calibre.url) {
    console.log(`   Calibre Auth: ${CONFIG.calibre.username ? '✓ Username/password set' : '○ No auth (public instance)'}`);
  }
  console.log(`\n📝 Make sure to set environment variables!`);
  
  loginToQBittorrent();
  
  // List Calibre library on startup for debugging
  if (CONFIG.calibre.url) {
    setTimeout(() => listCalibreLibrary(), 1000);
  }
});
