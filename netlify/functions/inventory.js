const SNIPCART_SECRET = process.env.SNIPCART_SECRET_API_KEY;

exports.handler = async (event) => {
  // Only allow GET requests
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // If the secret API key is not configured, return an empty object gracefully so local staging runs fine
  if (!SNIPCART_SECRET) {
    return { 
      statusCode: 200, 
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}) 
    };
  }

  try {
    const response = await fetch('https://app.snipcart.com/api/products?limit=100', {
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${Buffer.from(SNIPCART_SECRET + ':').toString('base64')}`
      }
    });

    if (!response.ok) {
      console.error('Failed to fetch Snipcart inventory:', response.status);
      return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) };
    }

    const data = await response.json();
    const items = data.items || [];
    
    // Map userProductId -> stock level
    const inventory = {};
    items.forEach(item => {
      inventory[item.userProductId] = item.stock;
    });

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60' // Cache for 1 minute on Netlify edge CDN
      },
      body: JSON.stringify(inventory)
    };

  } catch (error) {
    console.error('Inventory fetch error:', error);
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) };
  }
};
