const { createApp } = require('../src/app');

const app = createApp();

// Vercel imports this module and calls the exported handler directly.
// Running it locally (`node api/index.js` / `npm run dev`) instead starts
// a real listener.
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`victim-app listening on :${port}`));
}

module.exports = app;
