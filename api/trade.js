export default async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { token, category, contract_money, contract_count, period, number, guess_type } = req.body;

    if (!token || !category || !contract_money || !period || !guess_type) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Safety: max bet limit
    if (contract_money > 300) {
      return res.status(400).json({ error: 'Bet amount exceeds safety limit of 300' });
    }

    const response = await fetch('https://cooe02.in/win/add_user_guess', {
      method: 'POST',
      headers: {
        'User-Agent': 'UnityPlayer/2019.4.17f1',
        'Accept': '*/*',
        'Accept-Encoding': 'deflate, gzip',
        'Content-Type': 'application/json',
        'Authorization': `Token ${token}`,
        'X-Unity-Version': '2019.4.17f1'
      },
      body: JSON.stringify({
        category,
        contract_money,
        contract_count: contract_count || 1,
        period: String(period),
        number: number ?? -1,
        guess_type
      })
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Trade proxy error:', error);
    return res.status(500).json({ error: 'Trade failed', message: error.message });
  }
}
