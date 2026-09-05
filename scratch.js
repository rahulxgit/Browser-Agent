const { chromium } = require('@playwright/test');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  // Using a known public form URL with radios
  await page.goto('https://docs.google.com/forms/d/e/1FAIpQLScJgUeK2H8fK6n8i7x2O9-b-8q9M6gY2u8E4jJzZ_tPz0Sg8g/viewform', { waitUntil: 'networkidle' });
  
  await page.waitForTimeout(2000);

  const html = await page.evaluate(() => {
    const radio = document.querySelector('[role="radio"]');
    if (!radio) return 'No radio found on ' + location.href;
    const radiogroup = radio.closest('[role="radiogroup"]');
    if (radiogroup) return 'Radiogroup ID: ' + radiogroup.id;
    return 'No radiogroup parent. Parent role: ' + radio.parentElement.getAttribute('role');
  });
  
  console.log(html);
  await browser.close();
})();
