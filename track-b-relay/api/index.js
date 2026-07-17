const { createApp } = require('../src/app');

const app = createApp();

if (require.main === module) {
  const port = process.env.PORT || 3001;
  app.listen(port, () => console.log(`track-b-relay listening on :${port}`));
}

module.exports = app;
