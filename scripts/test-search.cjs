// Quick test: fetch Google Images for one product
async function test() {
  const query = 'حليب المراعي product -site:unsplash.com -site:pexels.com -site:pinterest.com';
  const searchUrl = 'https://www.google.com/search?q=' + encodeURIComponent(query) + '&udm=2&tbs=isz:m';
  console.log('Fetching Google Images...');
  
  const response = await fetch(searchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,ar;q=0.8',
    },
  });
  console.log('Status:', response.status);
  const html = await response.text();
  console.log('HTML length:', html.length);
  
  // Check if blocked
  if (html.includes('unusual traffic') || html.includes('captcha')) {
    console.log('BLOCKED by Google CAPTCHA');
    return;
  }
  
  // Try to find image URLs using string search
  const urls = new Set();
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp'];
  
  // Find all URLs in the HTML
  const urlRegex = new RegExp('https?://[^"\\s<>\\\\]+', 'gi');
  let match;
  while ((match = urlRegex.exec(html)) !== null) {
    const url = match[0].toLowerCase();
    if (imageExtensions.some(ext => url.includes(ext))) {
      urls.add(match[0]);
    }
  }
  
  console.log('\nFound', urls.size, 'image URLs:');
  [...urls].slice(0, 20).forEach((u, i) => console.log(i + ':', u.substring(0, 150)));
}

test().catch(console.error);
