// Akan markdown → güvenli HTML. Kod blokları renklendirilir ve kopyalanabilir.
(() => {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const renderer = {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0];
      let html;
      try {
        html = language && hljs.getLanguage(language)
          ? hljs.highlight(text, { language, ignoreIllegals: true }).value
          : hljs.highlightAuto(text).value;
      } catch { html = esc(text); }
      return `<figure class="code"><figcaption><span>${esc(language || 'kod')}</span><button class="copy" data-copy>Kopyala</button></figcaption><pre><code class="hljs">${html}</code></pre></figure>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      return `<a href="${esc(href || '')}" target="_blank" rel="noreferrer"${title ? ` title="${esc(title)}"` : ''}>${text}</a>`;
    },
  };
  marked.use({ gfm: true, breaks: false, renderer });

  // Akış sırasında kapanmamış ``` bloklarını geçici olarak kapat
  const balance = (src) => ((src.match(/^```/gm) || []).length % 2 ? src + '\n```' : src);

  window.Markdown = {
    render(src) {
      return DOMPurify.sanitize(marked.parse(balance(src || '')), { ADD_ATTR: ['target', 'data-copy'] });
    },
    escape: esc,
  };
})();
