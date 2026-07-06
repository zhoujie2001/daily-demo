// 前端兜底书单：后端 /api/reading 不可用时展示这份
// 字段与后端 books 表一致：title / author / year / rating / status / note / cover_url
export const books = [
  { id: 'seed-1', title: '霍乱时期的爱情', author: '加西亚·马尔克斯', year: '2024', rating: 5, status: 'read', note: '', cover_url: '' },
  { id: 'seed-2', title: '花街往事', author: '路内', year: '2024', rating: 4, status: 'read', note: '', cover_url: '' },
  { id: 'seed-3', title: '献给阿尔吉侬的花束', author: '丹尼尔·凯斯', year: '2024', rating: 5, status: 'read', note: '', cover_url: '' },
  { id: 'seed-4', title: '花开不败', author: '简嫃', year: '2024', rating: 4, status: 'read', note: '', cover_url: '' },
  { id: 'seed-5', title: '挪威的森林', author: '村上春树', year: '2024', rating: 5, status: 'read', note: '', cover_url: '' },
  { id: 'seed-6', title: '麦田里的守望者', author: 'J.D.塞林格', year: '2024', rating: 4, status: 'read', note: '', cover_url: '' },
  { id: 'seed-7', title: '1988：我想和这个世界谈谈', author: '韩寒', year: '2024', rating: 4, status: 'read', note: '', cover_url: '' },
  { id: 'seed-8', title: '草民', author: '梁鸿', year: '2024', rating: 4, status: 'read', note: '', cover_url: '' },
  { id: 'seed-9', title: '命运', author: '蔡崇达', year: '2024', rating: 4, status: 'read', note: '', cover_url: '' },
  { id: 'seed-10', title: '少年巴比伦', author: '路内', year: '2024', rating: 4, status: 'read', note: '', cover_url: '' },
  { id: 'seed-11', title: '追随她的旅程', author: '路内', year: '2024', rating: 4, status: 'read', note: '', cover_url: '' },
];

export const BOOK_STATUS_OPTIONS = [
  { value: 'read', label: '已读' },
  { value: 'reading', label: '在读' },
  { value: 'want', label: '想读' },
];

export function statusLabel(value) {
  const found = BOOK_STATUS_OPTIONS.find((s) => s.value === value);
  return found ? found.label : value || '已读';
}
