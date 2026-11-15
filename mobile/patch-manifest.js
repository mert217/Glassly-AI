// Android bildirimine (AndroidManifest.xml) Glassly'nin ihtiyaçlarını ekler:
// mikrofon izni ve Google girişinden uygulamaya dönüş bağlantısı (biz.glassly.app://).
const fs = require('fs');
const p = 'android/app/src/main/AndroidManifest.xml';
let x = fs.readFileSync(p, 'utf8');
for (const perm of ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.POST_NOTIFICATIONS']) {
  if (!x.includes(perm)) x = x.replace('</manifest>', `    <uses-permission android:name="${perm}" />\n</manifest>`);
}
if (!x.includes('android:scheme="biz.glassly.app"')) {
  const filter = `
            <intent-filter>
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="biz.glassly.app" />
            </intent-filter>
`;
  const i = x.indexOf('</activity>');
  if (i < 0) throw new Error('activity bulunamadı');
  x = x.slice(0, i) + filter + '        ' + x.slice(i);
}
fs.writeFileSync(p, x);
console.log(x);
