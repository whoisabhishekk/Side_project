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
      return res.status(400).json({ error: 'Missing required fields', received: { category, contract_money, period, guess_type: guess_type || 'MISSING' } });
    }

    // Safety: max bet limit
    if (contract_money > 300) {
      return res.status(400).json({ error: 'Bet amount exceeds safety limit of 300' });
    }

    const requestBody = {
      category,
      contract_money: Number(contract_money),
      contract_count: contract_count || 1,
      period: String(period),
      number: number ?? -1,
      guess_type
    };

    console.log('[Trade Proxy] Request to Cooe:', JSON.stringify(requestBody));

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
      body: JSON.stringify(requestBody)
    });

    const data = await response.json();
    console.log('[Trade Proxy] Cooe Response:', response.status, JSON.stringify(data));
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Trade proxy error:', error);
    return res.status(500).json({ error: 'Trade failed', message: error.message });
  }
}
