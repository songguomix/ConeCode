import type { ArtPresetStyle, AspectRatio } from './types';

export const ART_PRESET_STYLES: ArtPresetStyle[] = [
  {
    id: 'photorealistic',
    name: '真实摄影',
    nameEn: 'Photorealistic',
    description: '极致细节，专业人像/风光大片质感',
    promptSuffix: 'photorealistic, 8k resolution, shot on 35mm lens, f/1.8, cinematic lighting, sharp focus, master photography, hyperdetailed',
    badgeColor: 'from-blue-500/20 to-cyan-500/20 text-cyan-400 border-cyan-500/30',
  },
  {
    id: 'anime',
    name: '二次元动漫',
    nameEn: 'Anime',
    description: '新海诚/吉卜力唯美清新动漫画风',
    promptSuffix: 'Makoto Shinkai anime aesthetic, vibrant lighting, clean line art, beautiful color palette, detailed anime illustration, Studio Ghibli vibes, 4k digital art',
    badgeColor: 'from-pink-500/20 to-rose-500/20 text-pink-400 border-pink-500/30',
  },
  {
    id: 'cyberpunk',
    name: '赛博朋克',
    nameEn: 'Cyberpunk',
    description: '霓虹夜雨，高科技未来感与机械美学',
    promptSuffix: 'cyberpunk aesthetic, vibrant neon glow, wet rainy streets with reflections, futuristic high-tech metropolis, volumetric fog, dark sci-fi atmosphere, 8k render',
    badgeColor: 'from-purple-500/20 to-indigo-500/20 text-purple-400 border-purple-500/30',
  },
  {
    id: 'pixar_3d',
    name: '3D萌系盲盒',
    nameEn: '3D Pixar',
    description: '迪士尼皮克斯3D卡通，可爱柔和粘土光影',
    promptSuffix: 'cute 3D character, Pixar Disney style animation, soft studio lighting, smooth clay texture, Octane 3D render, adorable expression, vibrant pastel tones',
    badgeColor: 'from-amber-500/20 to-orange-500/20 text-amber-400 border-amber-500/30',
  },
  {
    id: 'ink_wash',
    name: '东方水墨',
    nameEn: 'Chinese Ink',
    description: '传统国风青绿山水与泼墨意境',
    promptSuffix: 'traditional Chinese ink wash painting, ethereal watercolor textures, elegant brush strokes, misty mountains, atmospheric Zen, poetic oriental aesthetic',
    badgeColor: 'from-emerald-500/20 to-teal-500/20 text-emerald-400 border-emerald-500/30',
  },
  {
    id: 'oil_painting',
    name: '古典油画',
    nameEn: 'Oil Painting',
    description: '文艺复兴与印象派大师笔触与明暗对比',
    promptSuffix: 'masterpiece oil painting on canvas, heavy impasto brush strokes, dramatic chiaroscuro lighting, rich colors, classical fine art, golden hour warmth',
    badgeColor: 'from-yellow-600/20 to-amber-600/20 text-yellow-300 border-yellow-500/30',
  },
  {
    id: 'fantasy',
    name: '奇幻魔法',
    nameEn: 'Epic Fantasy',
    description: '宏大史诗，神秘符文与发光粒子',
    promptSuffix: 'epic high fantasy art, glowing magical particles, mystical ambiance, intricate fantasy architecture, cinematic concept art, legendary atmosphere',
    badgeColor: 'from-violet-500/20 to-fuchsia-500/20 text-fuchsia-400 border-fuchsia-500/30',
  },
  {
    id: 'minimalist',
    name: '极简美学',
    nameEn: 'Minimalist',
    description: '留白艺术，利落线条与高级低饱和配色',
    promptSuffix: 'minimalist design, clean lines, elegant negative space, Bauhaus aesthetic, tasteful muted color palette, modern graphic illustration, vector art',
    badgeColor: 'from-zinc-500/20 to-stone-500/20 text-zinc-300 border-zinc-500/30',
  },
  {
    id: 'pixel_art',
    name: '复古像素',
    nameEn: 'Pixel Art',
    description: '经典16位街机与怀旧像素点阵',
    promptSuffix: '16-bit pixel art, detailed retro game graphics, nostalgic arcade aesthetic, sharp pixel grid, vibrant 80s color palette, isometric perspective',
    badgeColor: 'from-green-500/20 to-lime-500/20 text-lime-400 border-lime-500/30',
  },
  {
    id: 'scifi',
    name: '硬核科幻',
    nameEn: 'Hard Sci-Fi',
    description: '星际深空，巨型机械与虚幻5电影级引擎',
    promptSuffix: 'hard sci-fi concept design, interstellar spaceship, titanium surfaces, Unreal Engine 5 render, cinematic wide-angle shot, space nebula background, photoreal',
    badgeColor: 'from-blue-600/20 to-indigo-600/20 text-blue-400 border-blue-500/30',
  },
];

export const INSPIRATION_PROMPTS = [
  '赛博朋克雨夜中的机械猫咪，坐在东京霓虹巷口的咖啡店招牌下，水洼倒映粉蓝光芒，金属毛发细腻光泽',
  '云海之上的悬浮古老蒸汽朋克飞艇，金色夕阳穿透层云，巨大的黄铜齿轮与玻璃穹顶',
  '发光水母悬浮在静谧森林之中，苔藓地面散发荧光微粒，丁达尔晨光穿透树冠，童话梦境般空灵',
  '玻璃球内的微缩热带雨林生态瓶，晶莹露珠与微型瀑布，微距摄影，浅景深，奇幻唯美',
  '戴复古圆框眼镜的橘猫咖啡师，正专注地拉花一杯冒热气的拿铁，温暖木质吧台与午后斜阳，皮克斯3D质感',
  '千里江山图画卷中的白鹤飞越险峻群山，金色晨曦破晓，青绿山水与现代云雾光影融合',
  '宇航员漫步在发光的紫色晶体异星沙漠，天幕悬挂两轮硕大的银色月球，星轨与星云交织',
  '深海遗迹中沉睡的机械巨鲸，外壳覆满发光珊瑚与幽蓝海葵，深海透光，宏大神秘',
  '未来极简主义智能玻璃别墅，坐落在雪山之巅的悬崖边，无边际泳池倒映晚霞与雪山峰顶',
  '复古暖阳下的夏日海边电车站，碧蓝海水波光粼粼，白色电车驶过铁轨，吉卜力治愈系氛围',
];

export const ASPECT_RATIOS: {
  id: AspectRatio;
  label: string;
  name: string;
  resolution: string;
  dalleResolution: string;
  w: number;
  h: number;
  desc: string;
}[] = [
  {
    id: '1:1',
    label: '1:1',
    name: '正方形',
    resolution: '1024x1024',
    dalleResolution: '1024x1024',
    w: 24,
    h: 24,
    desc: '头像 / 社交配图',
  },
  {
    id: '16:9',
    label: '16:9',
    name: '宽屏横幅',
    resolution: '1792x1024',
    dalleResolution: '1792x1024',
    w: 32,
    h: 18,
    desc: '电脑壁纸 / 视频横幅',
  },
  {
    id: '9:16',
    label: '9:16',
    name: '竖屏海报',
    resolution: '1024x1792',
    dalleResolution: '1024x1792',
    w: 18,
    h: 32,
    desc: '手机壁纸 / 故事海报',
  },
  {
    id: '4:3',
    label: '4:3',
    name: '经典横幅',
    resolution: '1024x768',
    dalleResolution: '1792x1024',
    w: 28,
    h: 21,
    desc: '传统画幅 / 展示卡片',
  },
  {
    id: '3:4',
    label: '3:4',
    name: '经典竖幅',
    resolution: '768x1024',
    dalleResolution: '1024x1792',
    w: 21,
    h: 28,
    desc: '肖像 / 杂志封面',
  },
];

/**
 * Intelligent prompt enhancement helper.
 * If user entered a short prompt, intelligently augments it with lighting,
 * composition, and visual qualities matching the chosen style.
 */
export function enrichPrompt(rawPrompt: string, styleId?: string): string {
  const trimmed = rawPrompt.trim();
  if (!trimmed) return '';

  const matchedStyle = ART_PRESET_STYLES.find((s) => s.id === styleId);
  const enhancements = [
    'high quality masterpiece',
    'volumetric cinematic lighting',
    'intricate textures and sharp focus',
  ];

  if (matchedStyle) {
    if (trimmed.includes(matchedStyle.promptSuffix)) return trimmed;
    return `${trimmed}, ${matchedStyle.promptSuffix}`;
  }

  // General enhancement if no specific style
  return `${trimmed}, ${enhancements.join(', ')}`;
}

export function getRandomPrompt(): string {
  const index = Math.floor(Math.random() * INSPIRATION_PROMPTS.length);
  return INSPIRATION_PROMPTS[index];
}

/** Normalized keys for the alias table below. */
function normalizeStyleKey(s: string): string {
  return s.toLowerCase().trim().replace(/[\s-]+/g, '_');
}

/**
 * Common style words a model writes instead of the preset id. Only
 * unambiguous synonyms live here — anything else resolves to no preset
 * rather than a wrong one.
 */
const STYLE_ALIASES: Record<string, string> = {
  photo: 'photorealistic',
  realistic: 'photorealistic',
  cinematic: 'photorealistic',
  pixar: 'pixar_3d',
  '3d': 'pixar_3d',
  '3d_render': 'pixar_3d',
  watercolor: 'ink_wash',
  watercolour: 'ink_wash',
  ink: 'ink_wash',
  chinese_ink: 'ink_wash',
  oil: 'oil_painting',
  oilpainting: 'oil_painting',
  epic: 'fantasy',
  minimal: 'minimalist',
  pixel: 'pixel_art',
  retro: 'pixel_art',
  scifi: 'scifi',
  sci_fi: 'scifi',
  sciencefiction: 'scifi',
};

/**
 * Resolve a free-text art style — as the model writes it into a
 * generate_image tool call — onto a preset id. Matching is tolerant (models
 * hyphenate, translate or abbreviate: "oil-painting", "Sci-Fi", "赛博朋克")
 * but never guesses: an unrecognized style means no preset, not a wrong one.
 */
export function resolveArtStyleId(input?: string): string {
  if (!input?.trim()) return '';
  const key = normalizeStyleKey(input);
  const direct = ART_PRESET_STYLES.find(
    (s) => normalizeStyleKey(s.id) === key
      || normalizeStyleKey(s.nameEn) === key
      || s.name === input.trim(),
  );
  if (direct) return direct.id;
  return STYLE_ALIASES[key] || '';
}
