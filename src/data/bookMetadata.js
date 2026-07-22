const PUBLIC_BASE_URL = String(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');

function publicAsset(path) {
  return `${PUBLIC_BASE_URL}${String(path).replace(/^\/+/, '')}`;
}

const BOOK_METADATA = {
  '树上的男爵': {
    coverUrl: publicAsset('images/books/the-baron-in-the-trees.jpg'),
  },
  '追随她的旅程': {
    coverUrl: publicAsset('images/books/follow-her-journey.jpg'),
  },
  命运: {
    coverUrl: publicAsset('images/books/fate.jpg'),
  },
  '1988：我想和这个世界谈谈': {
    coverUrl: publicAsset('images/books/1988.jpg'),
    year: '2010',
  },
  长日将尽: {
    coverUrl: publicAsset('images/books/the-remains-of-the-day.jpg'),
  },
  花街往事: {
    coverUrl: publicAsset('images/books/flower-street.jpg'),
  },
  霍乱时期的爱情: {
    coverUrl: publicAsset('images/books/love-in-the-time-of-cholera.jpg'),
  },
  献给阿尔吉侬的花束: {
    coverUrl: publicAsset('images/books/flowers-for-algernon.jpg'),
  },
};

const TITLE_ALIASES = {
  献给阿尔吉依的花束: '献给阿尔吉侬的花束',
};

export function resolveBookMetadata(rawTitle) {
  const originalTitle = String(rawTitle || '').trim();
  const title = TITLE_ALIASES[originalTitle] || originalTitle;
  return {
    title,
    ...(BOOK_METADATA[title] || {}),
  };
}
