// Makes sure the QA region and users exist before any spec is loaded.
import { setup, writeFixtures } from './admin.mjs';

export default async function globalSetup() {
  writeFixtures();
  await setup();
}
