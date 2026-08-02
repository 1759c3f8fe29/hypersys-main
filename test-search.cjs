const http = require('http');

const req = http.request({
  hostname: 'localhost',
  port: 5173,
  path: '/api/search?q=latest+news+2025',
  method: 'GET'
}, (res) => {
  let data = '';
  res.on('data', (chunk) => {
    data += chunk;
  });
  res.on('end', () => {
    console.log("Status:", res.statusCode);
    console.log("Body length:", data.length);
    console.log(data.slice(0, 1000));
  });
});

req.on('error', (e) => {
  console.error(e);
});
req.end();
