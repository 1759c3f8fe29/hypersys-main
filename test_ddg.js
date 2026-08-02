const q = "Nvidia stock";
fetch("https://lite.duckduckgo.com/lite/", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
  },
  body: `q=${encodeURIComponent(q)}`
})
.then(res => res.text())
.then(html => {
  const results = [];
  const rows = html.split('<tr');
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.includes('class="result-snippet"')) {
      const prevRow = rows[i-1];
      const titleMatch = prevRow.match(/<a[^>]*class="result-title"[^>]*>([\s\S]*?)<\/a>/);
      const linkMatch = prevRow.match(/href="([^"]+)"/);
      const snippetMatch = row.match(/class="result-snippet"[^>]*>([\s\S]*?)<\/td>/);
      
      if (titleMatch && snippetMatch) {
        let link = linkMatch ? linkMatch[1] : "";
        if (link.includes("uddg=")) {
          const m = link.match(/uddg=([^&]+)/);
          if (m) link = decodeURIComponent(m[1]);
        } else if (link.startsWith('//')) {
            link = "https:" + link;
        }
        results.push({
          title: titleMatch[1].replace(/<[^>]+>/g, "").trim(),
          link,
          snippet: snippetMatch[1].replace(/<[^>]+>/g, "").trim()
        });
      }
    }
  }
  console.log(JSON.stringify(results, null, 2));
});
