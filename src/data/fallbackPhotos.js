// 后端不可用时展示的静态照片兜底列表
export const fallbackPhotos = [
  { url: 'images/photo1.jpg', title: '星星上开满了花', desc: '成都 · 2023' },
  { url: 'images/photo2.jpg', title: '平潭一角', desc: '平潭 · 2024' },
  { url: 'images/photo3.jpg', title: '嘿，抬头', desc: '成都 · 2023' },
  { url: 'images/photo4.jpg', title: '马里冷旧', desc: '峨眉 · 2024' },
  { url: 'images/photo5.jpg', title: '风车&海田', desc: '平潭 · 2024' },
  { url: 'images/photo6.jpg', title: '沉思', desc: '平潭 · 2024' },
  { url: 'images/photo7.jpg', title: '你看那边', desc: '平潭 · 2024' },
  { url: 'images/photo8.jpg', title: '风车', desc: '平潭 · 2024' },
  { url: 'images/photo9.jpg', title: '修狗们', desc: '成都 · 2022' },
  { url: 'images/photo10.jpg', title: '日落', desc: '成都 · 2023' },
  { url: 'images/photo11.jpg', title: '你谁？', desc: '成都 · 2018' },
  { url: 'images/photo12.jpg', title: '傍晚', desc: '昆明 · 2024' },
  { url: 'images/photo13.jpg', title: '群山', desc: '川西 · 2024' },
  { url: 'images/photo14.jpg', title: '矮油，不错哦', desc: '海口 · 2024' },
  { url: 'images/photo16.jpg', title: '氧气', desc: '川西 · 2024' },
  { url: 'images/photo17.jpg', title: '苍山浮在洱海上', desc: '大理 · 2024' },
  { url: 'images/photo18.jpg', title: '燥热的空气', desc: '海南某处 · 2024' },
  { url: 'images/photo19.jpg', title: '境', desc: '鱼子西 · 2024' },
  { url: 'images/photo20.jpg', title: '快拍', desc: '鱼子西 · 2024' },
  { url: 'images/photo21.jpg', title: '新疆？', desc: '随机点 · 2024' },
  { url: 'images/photo22.jpg', title: '门缝里看鸥', desc: '昆明 · 2024' },
  { url: 'images/photo23.jpg', title: '翠湖', desc: '昆明 · 2024' },
  { url: 'images/photo24.jpg', title: '下一秒即将开抢的牛仔', desc: '昆明 · 2024' },
  { url: 'images/photo25.jpg', title: '呔', desc: '昆明 · 2024' },
  { url: 'images/photo26.jpg', title: '你贵，但值', desc: '昆明 · 2024' },
  { url: 'images/photo27.jpg', title: '你见到小王子了吗', desc: '鱼子西 · 2024' },
  { url: 'images/photo28.jpg', title: '威猛猛兽_Ariza', desc: '成都 · 2024' },
  { url: 'images/photo29.jpg', title: '小家伙', desc: '成都 · 2024' },
  { url: 'images/photo30.jpg', title: '日出', desc: '鱼子西 · 2024' },
];

// 后端不可用时展示的静态视频兜底列表
export const fallbackVideos = Array.from({ length: 10 }, (_, i) => ({
  url: `videos/travel${i + 1}.mp4`,
  title: `travel${i + 1}`,
}));
