const router = require('express').Router();
const https = require('https');

const GIPHY_API_KEY = process.env.GIPHY_API_KEY;

// Curated list of mock GIFs for fallback when no API key is set
const MOCK_GIFS = [
  { id: "14aUO0Mf7dWDXW", title: "SpongeBob Happy", url: "https://i.giphy.com/14aUO0Mf7dWDXW.gif", tags: ["happy", "excited", "spongebob", "joy"] },
  { id: "Vgbh2O7vU7oSk", title: "Minion Wave", url: "https://i.giphy.com/Vgbh2O7vU7oSk.gif", tags: ["hello", "wave", "minion", "hi"] },
  { id: "10JhviFuU2gWD6", title: "Laughing Hard", url: "https://i.giphy.com/10JhviFuU2gWD6.gif", tags: ["laugh", "lol", "funny", "haha"] },
  { id: "l4FGBOi0BhOUM8Y6A", title: "Love Heart", url: "https://i.giphy.com/l4FGBOi0BhOUM8Y6A.gif", tags: ["love", "heart", "cute", "kiss"] },
  { id: "l0IydbsCoHJ4D2cXY", title: "OMG Pikachu", url: "https://i.giphy.com/l0IydbsCoHJ4D2cXY.gif", tags: ["shocked", "omg", "what", "pikachu"] },
  { id: "9Y5BbDSkSTiY8", title: "Stitch Crying", url: "https://i.giphy.com/9Y5BbDSkSTiY8.gif", tags: ["sad", "cry", "stitch", "crying"] },
  { id: "JIX9t2j0ZTN9S", title: "Cat Keyboard", url: "https://i.giphy.com/JIX9t2j0ZTN9S.gif", tags: ["cat", "typing", "keyboard", "funny"] },
  { id: "4Zo41lssrjEJ9xgOPg", title: "Cute Dog Waving", url: "https://i.giphy.com/4Zo41lssrjEJ9xgOPg.gif", tags: ["dog", "hello", "cute", "wave"] },
  { id: "14udF3WUj6HOOVy", title: "Carlton Dance", url: "https://i.giphy.com/14udF3WUj6HOOVy.gif", tags: ["dance", "happy", "carlton", "party"] },
  { id: "3o7abKhOpuusi7PtTo", title: "Nodding Yes", url: "https://i.giphy.com/3o7abKhOpuusi7PtTo.gif", tags: ["yes", "agree", "nod", "ok"] },
  { id: "3o85xERD1ux5wAQ3EE", title: "Gordon Ramsay No", url: "https://i.giphy.com/3o85xERD1ux5wAQ3EE.gif", tags: ["no", "deny", "ramsay", "stop"] },
  { id: "26AHP7PeR5Gs5yT8A", title: "Minion Thank You", url: "https://i.giphy.com/26AHP7PeR5Gs5yT8A.gif", tags: ["thanks", "thank you", "minion", "grateful"] }
];

// Helper to make https requests returning JSON
function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

// Convert GIPHY's response format to a simpler format for our client
function mapGiphyGifs(giphyResponse) {
  if (!giphyResponse || !giphyResponse.data) return [];
  return giphyResponse.data.map(item => ({
    id: item.id,
    title: item.title,
    url: item.images?.fixed_width?.url || item.images?.original?.url || ""
  }));
}

router.get('/trending', async (req, res) => {
  if (!GIPHY_API_KEY) {
    // Return mock trending gifs
    return res.json({ success: true, gifs: MOCK_GIFS, source: 'fallback' });
  }
  try {
    const url = `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=20&rating=g`;
    const data = await fetchJson(url);
    const gifs = mapGiphyGifs(data);
    res.json({ success: true, gifs, source: 'giphy' });
  } catch (error) {
    console.error("Giphy trending error:", error);
    // Graceful fallback to mock data on live API error
    res.json({ success: true, gifs: MOCK_GIFS, source: 'error-fallback' });
  }
});

router.get('/search', async (req, res) => {
  const query = req.query.q ? req.query.q.trim().toLowerCase() : '';
  if (!query) {
    return res.json({ success: true, gifs: [] });
  }

  if (!GIPHY_API_KEY) {
    // Filter mock gifs by matching tag or title
    const filtered = MOCK_GIFS.filter(gif => 
      gif.title.toLowerCase().includes(query) || 
      gif.tags.some(tag => tag.includes(query))
    );
    return res.json({ success: true, gifs: filtered, source: 'fallback' });
  }

  try {
    const url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=20&rating=g`;
    const data = await fetchJson(url);
    const gifs = mapGiphyGifs(data);
    res.json({ success: true, gifs, source: 'giphy' });
  } catch (error) {
    console.error("Giphy search error:", error);
    // Graceful fallback
    const filtered = MOCK_GIFS.filter(gif => 
      gif.title.toLowerCase().includes(query) || 
      gif.tags.some(tag => tag.includes(query))
    );
    res.json({ success: true, gifs: filtered, source: 'error-fallback' });
  }
});

module.exports = router;
