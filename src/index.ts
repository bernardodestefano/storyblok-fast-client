import { SbFastClient } from './storyblok-fast-client';
import { getCacheVersion } from './utils';

const spaceVersion = await getCacheVersion(
  process.env.STORYBLOK_ACCESS_TOKEN || ''
);

const client = new SbFastClient({
  accessToken: process.env.STORYBLOK_ACCESS_TOKEN || '',
  version: spaceVersion,
});

client.getAllStories();
