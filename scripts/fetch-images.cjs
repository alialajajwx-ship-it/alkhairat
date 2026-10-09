const fs = require('fs');
const path = require('path');

const PRODUCT_URLS = {
  '6eb2dc2c': 'https://www.carrefourksa.com/mafsau/en/full-fat-milk/almarai-fresh-milk-ff-2l/p/106475',
  '20589c87': 'https://www.carrefourksa.com/mafsau/en/full-fat-yogurt/almarai-yogurt-ff-170g-x6/p/357352',
  '9d83227c': 'https://www.carrefourksa.com/mafsau/en/spread-processed-cheese/kiri-square-cheese-x6/p/58651',
  'ededae23': 'https://www.carrefourksa.com/mafsau/en/labneh/al-safi-creamy-labneh-400g/p/689003',
  '3f0df6f8': 'https://www.carrefourksa.com/mafsau/en/cola/pepsi-pet-400ml/p/652261',
  '51e40c78': 'https://www.carrefourksa.com/mafsau/ar/black-bags/lipton-yellow-label-tea-bag-x100/p/388804',
  '3dad3637': 'https://www.carrefourksa.com/mafsau/en/coffee/almarai-arabic-coffee/cardamom-400g/p/702646',
  '4e1b72eb': 'https://www.carrefourksa.com/mafsau/ar/orange-juice/almarai-orange-juice-andalusian-1l/p/642101',
  '6285d5c1': 'https://www.carrefourksa.com/mafsau/ar/still-water/nestle-pure-life-water-600ml/p/18378',
  '110565b4': 'https://www.carrefourksa.com/mafsau/en/frozen-meat/frooz-chicken-breast-boneless/p/681808',
  'e146b279': 'https://www.carrefourksa.com/mafsau/ar/local-arabic-lamb/naimy-leg-boneless-male/p/577094',
  '58d9cb9c': 'https://www.carrefourksa.com/mafsau/ar/local-beef/local-fresh-beef-mince/p/553261',
  '571a7a2d': 'https://www.carrefourksa.com/mafsau/en/frozen-meat/raw-chicken-liver/p/681813',
  '58c15ecd': 'https://www.carrefourksa.com/mafsau/en/processed-meat/chicken-sausage/p/681830',
  '7a1fc973': 'https://www.carrefourksa.com/mafsau/ar/dates/alwani-ajwa-dates-800g/p/426800',
  '322181db': 'https://www.carrefourksa.com/mafsau/ar/dates/sukkary-box-800-gm/p/571050',
  'd872251e': 'https://www.carrefourksa.com/mafsau/ar/tomato/tomato-green-house/p/78461',
  '31e7aa7a': 'https://www.carrefourksa.com/mafsau/ar/cucumber/sgm-cucumber-kg/p/688338',
  'd1417568': 'https://www.carrefourksa.com/mafsau/ar/lemon-lime/lemon/p/77972',
  '87c43e83': 'https://www.carrefourksa.com/mafsau/ar/facial-tissues/alwazir-soft-premium-tissues-300/p/760269',
  '60fadca4': 'https://www.carrefourksa.com/mafsau/ar/antibacterial-soap/dettol-barsoap-original-165g-x3-1/p/295564',
  '76f7c9af': 'https://www.carrefourksa.com/mafsau/ar/laundry-detergents/tide-powder-lf-floral-fa-2-25kg/p/724075',
  '5c11d089': 'https://www.carrefourksa.com/mafsau/en/household/trash-bags/p/681860',
  '4c7b7343': 'https://www.carrefourksa.com/mafsau/en/air-freshner-spray/airwick-spray-jasmine-300ml-x2-1/p/443156',
  'a781f906': 'https://www.carrefourksa.com/mafsau/ar/local-special-bread/arabic-bread/p/676859',
  '96cd48c4': 'https://www.carrefourksa.com/mafsau/ar/local-special-bread/arabic-bread/p/676859',
  '768a1fd1': 'https://www.carrefourksa.com/mafsau/en/salted-products/l-usine-croissant-plain-60g/p/100843',
  '858ee3a7': 'https://www.carrefourksa.com/mafsau/ar/donuts/donut-parfum-vanille-53-g/p/740427',
  '8e71a77d': 'https://www.carrefourksa.com/mafsau/ar/date-fruit-filled/tea-shop-abu-walad-18x45g/p/721734',
};

function extractOgImage(html) {
  const ogMatch = html.match(/property=["']og:image["']\s+content=["'](https?:\/\/[^"']+)["']/i)
    || html.match(/content=["'](https?:\/\/[^"']+)["']\s+property=["']og:image["']/i);
  if (ogMatch) return ogMatch[1];

  const twMatch = html.match(/name=["']twitter:image["']\s+content=["'](https?:\/\/[^"']+)["']/i)
    || html.match(/content=["'](https?:\/\/[^"']+)["']\s+name=["']twitter:image["']/i);
  if (twMatch) return twMatch[1];

  const imgMatch = html.match(/src=["'](https?:\/\/[^"']+\.(jpg|jpeg|png|webp)[^"']*)["']/i);
  if (imgMatch) return imgMatch[1];

  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchOgImage(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
      redirect: 'follow',
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const html = await response.text();
    return extractOgImage(html);
  } catch (err) {
    return null;
  }
}

async function main() {
  const productsPath = path.join(__dirname, '..', 'data', 'products.json');
  const products = JSON.parse(fs.readFileSync(productsPath, 'utf-8'));

  console.log(`\n🔍 Fetching og:image for ${products.length} products...\n`);

  for (let i = 0; i < products.length; i++) {
    const product = products[i];
    const url = PRODUCT_URLS[product.id];

    if (!url) {
      console.log(`${i + 1}. ${product.name}: No URL mapped`);
      product.imageUrl = null;
      continue;
    }

    process.stdout.write(`${i + 1}. ${product.name} ... `);

    const imageUrl = await fetchOgImage(url);
    product.imageUrl = imageUrl || null;

    if (imageUrl) {
      console.log(`✅`);
    } else {
      console.log(`❌`);
    }

    if (i < products.length - 1) {
      await sleep(1500);
    }
  }

  fs.writeFileSync(productsPath, JSON.stringify(products, null, 2), 'utf-8');
  console.log(`\n✅ Done! Saved to ${productsPath}`);

  const withImages = products.filter(p => p.imageUrl).length;
  const withoutImages = products.filter(p => !p.imageUrl).length;
  console.log(`\n📊 Stats: ${withImages} with images, ${withoutImages} without images`);

  console.log('\n📋 Preview of first 3 items:');
  console.log(JSON.stringify(products.slice(0, 3), null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
