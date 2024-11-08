import { access, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export const RELATIONS_TO_RESOLVE: string[] = [
  'Target.modelLabel',
  'Target.modalTemplate',
  'List.label',
  'Template.story',
  'destination.tagLabel',
  'DestinationList.label',
  'DestinationList.fromLabel',
  'DestinationList.funnelingLabels',
  'DestinationCarousel.staticCards',
  'DestinationCarousel.fromLabel',
  'DestinationCarousel.seeAllLabel',
  'DestinationCarousel.funnelingLabels',
  'List.label',
  'ProductCarousel.products',
  'Stories.openCloseLabels',
  'Stories.previousNextLabels',
  'Stories.muteUnmuteLabels',
  'Template.story',
  'Testimonial.labels',
  'Target.funnelingLabels',
  'gallery.moreLabel',
  'InfomeetingCard.showLabels',
  'InfomeetingCard.checkboxLabel',
  'PopUp.dialogTemplate',
];

export const checkDir = async (path: string) => {
  try {
    await access(resolve(path));
  } catch (error) {
    await mkdir(resolve(path), { recursive: true });
  }
};

export const getFilteredMarketsForBuild = (marketCodes: string[]) => {
  if (process.env.MARKET)
    return marketCodes.filter((mkt) => mkt === process.env.MARKET);

  return marketCodes.filter((market) => market !== 'cn');
};

export const getCacheVersion = async (token: string) => {
  const response = await fetch(
    `https://api.storyblok.com/v2/cdn/spaces/me?token=${token}`
  );
  const data = await response.json();

  return data?.space ? data.space.version : Date.now();
};
