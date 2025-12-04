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

// Constants for filtering
const AUDIOBOOK_KEYWORDS = ['audiobook', 'audio book', '.m4b', '.mp3'];
const EBOOK_FORMATS = ['epub', 'mobi', 'pdf', 'azw', 'azw3'];

// Helper function to check if a title is an audiobook
function isAudiobook(title) {
  const lowerTitle = title.toLowerCase();
  return AUDIOBOOK_KEYWORDS.some(keyword => lowerTitle.includes(keyword));
}

// Helper function to check if a title contains an ebook format
function isEbookFormat(title) {
  const lowerTitle = title.toLowerCase();
  return EBOOK_FORMATS.some(format => lowerTitle.includes(format));
}

// Helper function to check if a title is in EPUB format
function isEpubFormat(title) {
  return /epub/i.test(title);
}

// Search Prowlarr for a book
async function searchProwlarr(title, author, isbn) {
  try {
    let searchQuery = title;
    if (author && author !== 'Unknown') {
      searchQuery += ` ${author}`;
    }

    console.log(`Searching Prowlarr for: ${searchQuery}`);

    const response = await axios.get(`${CONFIG.prowlarr.url}/api/v1/search`, {
      params: {
        query: searchQuery,
        type: 'book',
        limit: 50
      },
      headers: {
        'X-Api-Key': CONFIG.prowlarr.apiKey
      },
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

// Download from Prowlarr
async function downloadFromProwlarr(indexerId, guid) {
  try {
    console.log(`Grabbing release from indexer ${indexerId}`);

    const response = await axios.post(
      `${CONFIG.prowlarr.url}/api/v1/search`,
      {
        guid: guid,
        indexerId: indexerId
      },
      {
        headers: {
          'X-Api-Key': CONFIG.prowlarr.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );

    return response.data;
  } catch (error) {
    console.error('Prowlarr download error:', error.message);
    throw error;
  }
}

// Hardcover GraphQL query constant (Updated to fetch all required fields)
const HARDCOVER_SEARCH_QUERY = `
  query SearchBooks($query: String!) {
    search(query: $query, query_type: "Book", per_page: 20) {
      results {
        document {
          id
          title
          description
          image
          release_year
          pages
          isbns
          contributions {
            author {
              name
            }
          }
          author_names
          average_rating
          url
        }
      }
    }
  }
`;

// Map Hardcover hit to book object (Original mapping)
function mapHardcoverHit(hit) {
  // This is the original mapping logic
  return {
    id: hit.document.id,
    title: hit.document.title,
    description: hit.document.description,
    image: hit.document.image,
    release_year: hit.document.release_year,
    pages: hit.document.pages,
    isbn_10: hit.document.isbns?.[1],
    isbn_13: hit.document.isbns?.[0],
    contributions: hit.document.contributions?.map(contrib => ({
      author: contrib.author
    })),
    author_names: hit.document.author_names,
    // These fields were added for the new feature but will be null/undefined
    // until the query is updated in the next phase.
    average_rating: hit.document.average_rating, 
    url: hit.document.url
  };
}

// API Routes

// Proxy Hardcover search through backend
app.post('/api/search', async (req, res) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ 
        success: false, 
        error: 'Search query is required' 
      });
    }

    console.log(`Searching Hardcover for: ${query}`);

    const response = await axios.post(
      'https://api.hardcover.app/v1/graphql',
      {
        query: HARDCOVER_SEARCH_QUERY,
        variables: { query: query }
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.hardcover.apiKey.replace(/^Bearer\s+/i, '')}`
        },
        timeout: 10000
      }
    );

    if (response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
      return res.status(500).json({
        success: false,
        error: 'Hardcover API error - check your API key'
      });
    }

    // The results contain a Typesense response with hits
    const searchResults = response.data.data?.search?.results || [];
    const books = searchResults.map(mapHardcoverHit);

    res.json({
      success: true,
      books: books
    });

  } catch (error) {
    console.error('Hardcover search error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Download endpoint
app.post('/api/download', async (req, res) => {
  try {
    const { title, author, isbn, year } = req.body;

    if (!title) {
      return res.status(400).json({ 
        success: false, 
        error: 'Book title is required' 
      });
    }

    console.log('\n=== New Download Request ===');
    console.log(`Title: ${title}`);
    console.log(`Author: ${author}`);
    console.log(`ISBN: ${isbn}`);
    console.log(`Year: ${year}`);

    // Search Prowlarr
    const results = await searchProwlarr(title, author, isbn);

    if (!results || results.length === 0) {
      return res.json({
        success: false,
        error: 'No results found in indexers'
      });
    }

    // Filter and sort results
    const sortedResults = results
      .filter(r => {
        if (!r.title || !r.guid) return false;
        // Exclude audiobooks and only include ebook formats
        return !isAudiobook(r.title) && isEbookFormat(r.title);
      })
      .sort((a, b) => {
        // Prefer EPUB format
        const aIsEpub = isEpubFormat(a.title);
        const bIsEpub = isEpubFormat(b.title);
        
        if (aIsEpub && !bIsEpub) return -1;
        if (!aIsEpub && bIsEpub) return 1;
        
        // Sort by seeders
        return (b.seeders || 0) - (a.seeders || 0);
      });

    if (sortedResults.length === 0) {
      return res.json({
        success: false,
        error: 'No ebook results found (only audiobooks available)'
      });
    }

    const bestResult = sortedResults[0];
    console.log(`Selected: ${bestResult.title}`);
    console.log(`  Size: ${(bestResult.size / 1024 / 1024).toFixed(2)} MB`);
    console.log(`  Seeders: ${bestResult.seeders || '?'}`);
    console.log(`  Indexer: ${bestResult.indexer}`);

    // Grab the release
    await downloadFromProwlarr(bestResult.indexerId, bestResult.guid);

    res.json({
      success: true,
      message: 'Download started',
      details: {
        title: bestResult.title,
        size: `${(bestResult.size / 1024 / 1024).toFixed(2)} MB`,
        indexer: bestResult.indexer,
        seeders: bestResult.seeders
      }
    });

  } catch (error) {
    console.error('Download error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok',
    config: {
      hardcover: CONFIG.hardcover.apiKey ? 'API key set' : 'API key missing',
      prowlarr: CONFIG.prowlarr.url,
      qbittorrent: CONFIG.qbittorrent.url,
      calibre: CONFIG.calibre.ingestFolder
    },
    timestamp: new Date().toISOString()
  });
});

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n📚 Liberry Server running on http://0.0.0.0:${PORT}`);
  console.log(`\n⚙️  Configuration:`);
  console.log(`   Hardcover: ${CONFIG.hardcover.apiKey ? '✓ API key set' : '✗ API key missing'}`);
  console.log(`   Prowlarr: ${CONFIG.prowlarr.url}`);
  console.log(`   qBitTorrent: ${CONFIG.qbittorrent.url}`);
  console.log(`   Calibre: ${CONFIG.calibre.ingestFolder}`);
  console.log(`\n📝 Make sure to set environment variables in docker-compose.yml!`);
});

