// Odob chegarasi: uyatsiz (behayo, pornografik) so'rovlarni AI'ga yubormasdan rad etish.
// Bu — aniq so'zlar ro'yxati asosidagi tezkor filtr. Nozikroq holatlarni AI ko'rsatmasidagi qoida hal qiladi.
// Ta'limiy mavzular (biologiyada "jinsiy hujayra", "ko'payish" va h.k.) bloklanmasligi uchun
// ro'yxatda faqat bir ma'noli uyatsiz so'zlar bor.

export const INDECENT_REFUSAL =
  "Kechirasiz, men bunday mavzularda suhbatlashmayman. Gamma AI — ta'lim va ilm-fanga yordam beruvchi yordamchi. " +
  "Iltimos, o'qish, fanlar yoki boshqa foydali mavzu bo'yicha savol bering — mamnuniyat bilan yordam beraman.";

export const INDECENT_MEDIA_REFUSAL =
  "Kechirasiz, bu faylda odob doirasiga to'g'ri kelmaydigan tasvir bor. Men bunday materiallar bilan ishlamayman. " +
  "Iltimos, o'qish yoki ilm-fanga oid fayl yuboring.";

// Vision modeli uyatsiz rasmni ko'rsa, faqat shu belgini qaytaradi (providers.js dagi VISION_SYSTEM)
export const NSFW_MARKER = "NSFW_CONTENT";

// So'z boshi bilan moslanadigan o'zaklar (lotin va kirill)
const STEMS = [
  "porn", "порн", "hentai", "хентай", "xxx", "onlyfans", "erotik", "erotic", "эротик",
  "masturb", "мастурб", "orgasm", "оргазм", "nudes", "nude", "naked", "голая", "голые", "голый", "обнажен", "обнажён",
  "yalang'och", "yalangoch", "яланғоч", "sexy", "секси", "seks", "секс", "minet", "минет",
  "milf", "blowjob", "striptiz", "striptease", "стриптиз", "fohishaxona", "jalab",
  "шлюх",
];
// O'zakka mos kelsa ham bloklanmaydi: oddiy so'z (sport "seksiyasi") yoki huquqiy atama ("pornografiya" — qonun haqidagi savollar AI qoidasiga qoldiriladi)
const ALLOWED = ["seksiya", "seksiy", "секция", "pornograf", "порнограф"];
// Ibora sifatida qidiriladi
const PHRASES = ["18+", "intim video", "intim rasm", "интим видео", "интим фото"];
// "sex" faqat media/uyatsiz kontekstda bloklanadi
const SEX_CONTEXT = /\bsex\b.{0,20}\b(video|rasm|photo|pic|film|kino|chat|tape)|\b(video|rasm|photo|film|kino)\b.{0,20}\bsex\b/;

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[ʻʼ’‘`´]/g, "'")
    .replace(/\s+/g, " ");
}

export function isIndecent(text) {
  const s = normalize(text);
  if (!s) return false;
  const tokens = s.split(/[^\p{L}\p{N}'+]+/u).filter(Boolean);
  if (tokens.some((t) => !ALLOWED.some((a) => t.startsWith(a)) && STEMS.some((stem) => t.startsWith(stem)))) return true;
  if (PHRASES.some((w) => s.includes(w))) return true;
  return SEX_CONTEXT.test(s);
}
