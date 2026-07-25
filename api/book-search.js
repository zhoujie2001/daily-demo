import { lookupBooks } from '../server/bookLookup.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const result = await lookupBooks({
      title: req.query?.title,
      author: req.query?.author,
      isbn: req.query?.isbn,
    });
    res.setHeader(
      'Cache-Control',
      result.candidates.length
        ? 'public, s-maxage=3600, stale-while-revalidate=86400'
        : 'no-store, max-age=0'
    );
    return res.status(200).json(result);
  } catch (error) {
    return res.status(error.status || 500).json({
      error: error.message || '书籍封面搜索失败',
    });
  }
}
