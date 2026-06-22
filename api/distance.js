// api/distance.js
// Proxies Google Maps Distance Matrix API — keeps your API key server-side

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { origins, destinations } = req.body;
  if (!origins || !destinations) {
    return res.status(400).json({ error: 'origins and destinations required' });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Maps API not configured' });

  const params = new URLSearchParams({
    origins: Array.isArray(origins) ? origins.join('|') : origins,
    destinations: Array.isArray(destinations) ? destinations.join('|') : destinations,
    mode: 'driving',
    units: 'imperial',
    key: apiKey
  });

  try {
    const response = await fetch(
      `https://maps.googleapis.com/maps/api/distancematrix/json?${params}`
    );
    const data = await response.json();

    if (data.status !== 'OK') {
      return res.status(400).json({ error: data.status, message: data.error_message });
    }

    // Return simplified result: minutes and miles between each pair
    const results = data.rows.map((row, i) => ({
      origin: data.origin_addresses[i],
      destinations: row.elements.map((el, j) => ({
        destination: data.destination_addresses[j],
        status: el.status,
        minutes: el.status === 'OK' ? Math.round(el.duration.value / 60) : null,
        miles: el.status === 'OK' ? parseFloat((el.distance.value / 1609.34).toFixed(1)) : null,
        durationText: el.status === 'OK' ? el.duration.text : null,
        distanceText: el.status === 'OK' ? el.distance.text : null
      }))
    }));

    res.json({ results });
  } catch (err) {
    console.error('Maps API error:', err);
    res.status(500).json({ error: 'Maps request failed' });
  }
};
