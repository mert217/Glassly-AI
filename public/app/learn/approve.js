const el = id => document.getElementById(id);
const code = location.hash.slice(1).toUpperCase();
const login = el('login'), approve = el('approve'), status = el('status');
const auth = async (path, method = 'GET', body) => {
  let token = '';
  try { token = localStorage.getItem('glassly.token') || sessionStorage.getItem('glassly.token') || ''; } catch {}
  if (!token) throw Object.assign(new Error('Glassly hesabına giriş yap.'), { status: 401 });
  const r = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, 'content-type':'application/json' }, body:body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(j.error?.message || 'İşlem tamamlanamadı.'), {status:r.status});
  return j;
};
function handle(error) {
  status.textContent = error.message;
  if (error.status === 401) { login.href = '/app/?learn=' + code; login.hidden = false; approve.hidden = true; }
}
if (!/^[A-F0-9]{12}$/.test(code)) {
  status.textContent = 'Geçerli bir bağlantı isteği yok. İngilizce çalışma alanından yeniden başlat.';
} else {
  el('code').textContent = code;
  try {
    const data = await auth('/auth/me');
    el('account').textContent = `Bağlanacak hesap: ${data.user.name}`;
    approve.hidden = false;
  } catch (e) { handle(e); }
  approve.addEventListener('click', async () => {
    approve.disabled = true;
    status.textContent = 'Bağlantı doğrulanıyor…';
    try {
      await auth('/auth/learn/approve','POST',{code});
      approve.hidden = true;
      status.textContent = 'İzin verildi. Bu sekmeyi kapatıp İngilizce çalışma alanına dönebilirsin.';
    } catch (e) { handle(e); approve.disabled = false; }
  });
}
