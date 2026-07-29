const fetch = require('node-fetch');

async function test() {
  const url = `https://lite.duckduckgo.com/lite/`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
    body: `q=latest+news+2025`
  });
  const html = await res.text();
  console.log("HTML length:", html.length);
  console.log(html.slice(0, 1000));
}
test();
