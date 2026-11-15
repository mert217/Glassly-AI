// Kullanım: node scripts/sifre-ozeti.mjs 'şifren'
// Çıktıyı "eposta|ÇIKTI" biçiminde GLASSLY_DEVELOPER gizli değişkenine yapıştır.
import { hashPassword } from '../src/auth.js';
if (!process.argv[2]) { console.error("Kullanım: node scripts/sifre-ozeti.mjs 'şifren'"); process.exit(1); }
console.log(await hashPassword(process.argv[2]));
